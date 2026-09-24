import type { BlockLiveness, Instruction, Materials } from './types.js';
import { cmpStr, sortedStrings } from './util.js';

export type Emit = (
  iteration: number,
  kind: string,
  summary: string,
  detail: Record<string, unknown>,
) => void;

export interface LivenessResult {
  trace: BlockLiveness[];
  liveAfter: Map<string, Set<string>>;
  liveBefore: Map<string, Set<string>>;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** 向后数据流：phi 的使用按前驱边计入前驱块 live-out，而非 phi 所在块。 */
export function computeLiveness(
  materials: Materials,
  instrs: Instruction[],
  emit: Emit,
  iteration: number,
): LivenessResult {
  const byBlock = new Map<string, Instruction[]>();
  for (const b of materials.blocks) byBlock.set(b.name, []);
  for (const i of instrs) {
    const list = byBlock.get(i.block);
    if (list) list.push(i);
  }
  for (const list of byBlock.values()) list.sort((a, b) => a.order - b.order);

  const phiDefs = new Map<string, Set<string>>();
  const blockDefs = new Map<string, Set<string>>();
  const upwardUses = new Map<string, Set<string>>();
  const edgePhiUses = new Map<string, string[]>();

  for (const b of materials.blocks) {
    const list = byBlock.get(b.name)!;
    const pd = new Set<string>();
    const d = new Set<string>();
    const up = new Set<string>();
    const definedBefore = new Set<string>();
    for (const i of list) {
      if (i.op === 'phi') {
        for (const df of i.defs) {
          pd.add(df.name);
          d.add(df.name);
          definedBefore.add(df.name);
        }
        for (const pu of i.phiUses) {
          const key = `${pu.pred}->${b.name}`;
          if (!edgePhiUses.has(key)) edgePhiUses.set(key, []);
          edgePhiUses.get(key)!.push(pu.name);
          emit(iteration, 'phi_edge_use_counted',
            `phi ${i.id} 的使用 ${pu.name} 计入前驱边 ${pu.pred}->${b.name} 的活跃性`,
            { phi: i.id, pred: pu.pred, succ: b.name, vreg: pu.name });
        }
      } else {
        for (const u of i.uses) if (!definedBefore.has(u.name)) up.add(u.name);
        for (const df of i.defs) {
          d.add(df.name);
          definedBefore.add(df.name);
        }
      }
    }
    phiDefs.set(b.name, pd);
    blockDefs.set(b.name, d);
    upwardUses.set(b.name, up);
  }

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  for (const b of materials.blocks) {
    liveIn.set(b.name, new Set());
    liveOut.set(b.name, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of materials.blocks) {
      const out = new Set<string>();
      for (const s of b.succs) {
        for (const v of liveIn.get(s)!) out.add(v);
        for (const v of edgePhiUses.get(`${b.name}->${s}`) ?? []) out.add(v);
      }
      const inn = new Set(upwardUses.get(b.name)!);
      for (const v of out) if (!blockDefs.get(b.name)!.has(v)) inn.add(v);
      if (!sameSet(inn, liveIn.get(b.name)!) || !sameSet(out, liveOut.get(b.name)!)) {
        liveIn.set(b.name, inn);
        liveOut.set(b.name, out);
        changed = true;
      }
    }
  }

  const trace: BlockLiveness[] = [];
  const liveAfterMap = new Map<string, Set<string>>();
  const liveBeforeMap = new Map<string, Set<string>>();
  for (const b of materials.blocks) {
    const list = byBlock.get(b.name)!;
    let liveAfter = new Set(liveOut.get(b.name)!);
    const instrTrace: BlockLiveness['instrs'] = [];
    for (let idx = list.length - 1; idx >= 0; idx -= 1) {
      const i = list[idx];
      const after = new Set(liveAfter);
      const before = new Set(after);
      for (const df of i.defs) before.delete(df.name);
      if (i.op !== 'phi') for (const u of i.uses) before.add(u.name);
      liveAfterMap.set(i.id, after);
      liveBeforeMap.set(i.id, before);
      instrTrace.unshift({ id: i.id, liveBefore: sortedStrings(before), liveAfter: sortedStrings(after) });
      liveAfter = before;
    }
    trace.push({
      block: b.name,
      liveIn: sortedStrings(liveIn.get(b.name)!),
      liveOut: sortedStrings(liveOut.get(b.name)!),
      instrs: instrTrace,
    });
  }
  trace.sort((a, b) => cmpStr(a.block, b.block));
  return { trace, liveAfter: liveAfterMap, liveBefore: liveBeforeMap };
}
