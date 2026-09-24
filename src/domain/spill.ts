import type { Instruction, Materials, PipelineParams, Quantity, RewriteEntry } from './types.js';
import { parseQuantity, weightFactor } from './units.js';
import { cmpStr } from './util.js';
import { instrToText } from './instr.js';
import type { Emit } from './liveness.js';

/** 溢出代价 = def 点 store 代价 + use 点（含 phi 边使用，按前驱块权重）load 代价。携带单位与基准。 */
export function spillCost(
  vreg: string,
  instrs: Instruction[],
  materials: Materials,
  params: PipelineParams,
  emit: Emit,
  iteration: number,
): Quantity {
  const store = parseQuantity(params.storeCost);
  const load = parseQuantity(params.loadCost);
  const blockWeight = new Map(materials.blocks.map((b) => [b.name, weightFactor(b.weight, params.loopExponent)]));
  const emitted = new Set<string>();
  let total = 0;
  const reasons: string[] = [];

  const apply = (unit: Quantity, factor: number | null, block: string) => {
    if (unit.value === null || unit.unit !== 'cycle') {
      reasons.push(`无法解析代价 "${unit.raw}"`);
      return;
    }
    if (factor === null) {
      reasons.push(`块 ${block} 权重不可转换`);
      return;
    }
    if (factor !== 1 && !emitted.has(block)) {
      emitted.add(block);
      emit(iteration, 'loop_weight_applied',
        `块 ${block} 的循环权重参与溢出代价（factor=${factor}）`,
        { block, factor, loopExponent: params.loopExponent });
    }
    total += unit.value * factor;
  };

  for (const i of instrs) {
    if (i.defs.some((d) => d.name === vreg)) apply(store, blockWeight.get(i.block) ?? null, i.block);
    if (i.uses.some((u) => u.name === vreg)) apply(load, blockWeight.get(i.block) ?? null, i.block);
    for (const pu of i.phiUses) {
      if (pu.name === vreg) apply(load, blockWeight.get(pu.pred) ?? null, pu.pred);
    }
  }

  if (reasons.length) {
    return {
      raw: `indeterminate: ${reasons.join('; ')}（vreg=${vreg}）`,
      value: null,
      unit: 'cycle',
      basis: `loopExponent=${params.loopExponent}`,
      diagnostic: reasons.join('; '),
    };
  }
  return {
    raw: `${total} cycle`,
    value: total,
    unit: 'cycle',
    basis: `loopExponent=${params.loopExponent}; store=${store.raw}; load=${load.raw}`,
  };
}

/** 溢出重写：def 后插 store，use 前插 load，phi 边使用在对应前驱块末尾插 load，全部使用新 vreg。 */
export function spillRewrite(
  instrs: Instruction[],
  victim: string,
  vregClass: Map<string, string>,
  iteration: number,
): { instrs: Instruction[]; newVregs: string[]; entries: RewriteEntry[] } {
  const cls = vregClass.get(victim);
  const out: Instruction[] = [];
  const newVregs: string[] = [];
  const entries: RewriteEntry[] = [];
  if (!cls) return { instrs, newVregs, entries };

  let counter = 0;
  const fresh = (tag: string) => {
    const name = `${victim}.${tag}${iteration}_${counter++}`;
    newVregs.push(name);
    vregClass.set(name, cls);
    return name;
  };

  const maxOrder = new Map<string, number>();
  for (const i of instrs) {
    maxOrder.set(i.block, Math.max(maxOrder.get(i.block) ?? -Infinity, i.order));
  }

  for (const i of instrs) {
    const usesVictim = i.uses.some((u) => u.name === victim);
    const defsVictim = i.defs.some((d) => d.name === victim);
    const phiHits = i.phiUses.filter((p) => p.name === victim);
    if (!usesVictim && !defsVictim && phiHits.length === 0) {
      out.push(i);
      continue;
    }

    const before = [instrToText(i)];
    const after: string[] = [];
    const cur: Instruction = {
      ...i,
      defs: i.defs.map((d) => ({ ...d })),
      uses: i.uses.map((u) => ({ ...u })),
      phiUses: i.phiUses.map((p) => ({ ...p })),
      move: i.move ? { ...i.move } : null,
      clobbers: [...i.clobbers],
    };

    if (usesVictim) {
      const rn = fresh('r');
      out.push({
        id: `${i.id}__rl${counter}`, block: i.block, order: i.order - 0.2, op: 'spill_reload',
        defs: [{ name: rn, cls }], uses: [], phiUses: [], move: null, call: false, clobbers: [],
        line: i.line, raw: `instr ${i.id}__rl${counter} @${i.block} def ${rn}:${cls} op spill_reload`,
      });
      cur.uses = cur.uses.map((u) => (u.name === victim ? { name: rn, cls } : u));
    }
    if (defsVictim) {
      const sn = fresh('s');
      cur.defs = cur.defs.map((d) => (d.name === victim ? { name: sn, cls } : d));
      out.push(cur);
      out.push({
        id: `${i.id}__st${counter}`, block: i.block, order: i.order + 0.2, op: 'spill_store',
        defs: [], uses: [{ name: sn, cls }], phiUses: [], move: null, call: false, clobbers: [],
        line: i.line, raw: `instr ${i.id}__st${counter} @${i.block} use ${sn} op spill_store`,
      });
    } else {
      out.push(cur);
    }
    for (const hit of phiHits) {
      const rn = fresh('r');
      const pred = hit.pred;
      const base = maxOrder.get(pred) ?? 0;
      out.push({
        id: `${i.id}__prl${counter}`, block: pred, order: base + 0.01 * counter + 0.5, op: 'spill_reload',
        defs: [{ name: rn, cls }], uses: [], phiUses: [], move: null, call: false, clobbers: [],
        line: i.line, raw: `instr ${i.id}__prl${counter} @${pred} def ${rn}:${cls} op spill_reload (phi-edge)`,
      });
      hit.name = rn;
    }

    after.push(...out.slice(-Math.min(out.length, 4)).map(instrToText));
    entries.push({
      iteration,
      kind: 'spill_rewrite',
      summary: `溢出 ${victim}：重写 ${i.id}（store/load，新 vreg）`,
      before,
      after: [instrToText(cur), ...(defsVictim ? [`spill_store after ${cur.id}`] : [])]
        .concat(phiHits.map((p) => `spill_reload on edge ${p.pred}->${i.block}`)),
    });
  }

  out.sort((a, b) => (a.block === b.block ? a.order - b.order : cmpStr(a.block, b.block)));
  return { instrs: out, newVregs, entries };
}
