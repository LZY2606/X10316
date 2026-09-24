import type { Block, Instr, Program, RewriteDiff } from './types';

// 溢出重写：为被溢出的 vreg 在 def 后插 store、use 前插 load，
// 产生新的短生命周期 vreg；重写后必须重新计算活跃性与干涉图（由管线保证）。

export function rewriteSpills(program: Program, spilled: string[], iteration: number): { program: Program; diffs: RewriteDiff[] } {
  const p: Program = structuredClone(program);
  const diffs: RewriteDiff[] = [];
  const spillSet = new Set(spilled);

  const fmt = (ins: Instr): string => {
    const parts = [ins.op];
    if (ins.defs.length) parts.push(`defs=${ins.defs.join(',')}`);
    if (ins.uses.length) parts.push(`uses=${ins.uses.join(',')}`);
    if (ins.phiArgs?.length) parts.push(`args=${ins.phiArgs.map((a) => `${a.pred}:${a.vreg}`).join(',')}`);
    if (ins.isMove) parts.push('move');
    if (ins.clobbers?.length) parts.push(`clobbers=${ins.clobbers.join(',')}`);
    return `${ins.id}: ${parts.join(' ')}`;
  };

  for (const b of p.blocks) {
    const next: Instr[] = [];
    b.instrs.forEach((ins, idx) => {
      const beforePoint = ins.point ?? { func: p.func, block: b.id, index: idx };
      // use 前插 load
      const usedSpilled = ins.uses.filter((u) => spillSet.has(u));
      if (usedSpilled.length && ins.op !== 'phi') {
        for (const u of usedSpilled) {
          const fresh = `${u}.r${iteration}u${next.length}`;
          p.vregs[fresh] = { name: fresh, cls: p.vregs[u].cls };
          const load: Instr = { id: `sp${iteration}.ld.${ins.id}.${u}`, op: 'load', defs: [fresh], uses: [], point: { ...beforePoint } };
          ins.uses = ins.uses.map((x) => (x === u ? fresh : x));
          diffs.push({ spilledVreg: u, before: [{ point: beforePoint, text: fmt({ ...ins, uses: ins.uses.map((x) => (x === fresh ? u : x)) }) }], after: [{ point: beforePoint, text: fmt(load) }, { point: beforePoint, text: fmt(ins) }] });
          next.push(load);
        }
      }
      next.push(ins);
      // def 后插 store
      const defSpilled = ins.defs.filter((d) => spillSet.has(d));
      if (defSpilled.length) {
        for (const d of defSpilled) {
          const fresh = `${d}.r${iteration}d${next.length}`;
          p.vregs[fresh] = { name: fresh, cls: p.vregs[d].cls };
          ins.defs = ins.defs.map((x) => (x === d ? fresh : x));
          const store: Instr = { id: `sp${iteration}.st.${ins.id}.${d}`, op: 'store', defs: [], uses: [fresh], point: { func: p.func, block: b.id, index: idx + 1 } };
          diffs.push({ spilledVreg: d, before: [{ point: beforePoint, text: fmt({ ...ins, defs: ins.defs.map((x) => (x === fresh ? d : x)) }) }], after: [{ point: beforePoint, text: fmt(ins) }, { point: { func: p.func, block: b.id, index: idx + 1 }, text: fmt(store) }] });
          next.push(store);
        }
      }
      // phi 的边使用：在前驱块末尾插 load
      if (ins.op === 'phi' && ins.phiArgs) {
        for (const a of ins.phiArgs) {
          if (!spillSet.has(a.vreg)) continue;
          const pred = p.blocks.find((x) => x.id === a.pred)!;
          const fresh = `${a.vreg}.r${iteration}p${pred.instrs.length}`;
          p.vregs[fresh] = { name: fresh, cls: p.vregs[a.vreg].cls };
          const load: Instr = { id: `sp${iteration}.pld.${ins.id}.${a.pred}.${a.vreg}`, op: 'load', defs: [fresh], uses: [], point: { func: p.func, block: a.pred, index: pred.instrs.length } };
          pred.instrs.push(load);
          diffs.push({ spilledVreg: a.vreg, before: [{ point: beforePoint, text: fmt(ins) }], after: [{ point: load.point!, text: fmt(load) }, { point: beforePoint, text: fmt({ ...ins, phiArgs: ins.phiArgs.map((x) => (x === a ? { ...x, vreg: fresh } : x)) }) }] });
          a.vreg = fresh;
        }
      }
    });
    b.instrs = next;
  }
  // 重新编号坐标（原始顺序坐标基准随重写更新，但指令 id 保持稳定）
  for (const b of p.blocks) b.instrs.forEach((ins, i) => { ins.point = { func: p.func, block: b.id, index: i }; });
  return { program: p, diffs };
}
