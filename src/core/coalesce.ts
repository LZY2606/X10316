import type { Instr, Program } from './types';
import type { InterferenceGraph } from './interference';

// Coalescing：保守 George 准则。失败的 move 必须保留（不能删 move）；
// 跨 register class 的 move 直接跳过（不错误合并）。

export interface CoalesceDecision {
  moveId: string;
  from: string;   // move 源
  to: string;     // move 目的
  result: 'merged' | 'kept' | 'cross-class-skipped';
  reason: string;
}

export function coalesce(
  program: Program,
  g: InterferenceGraph,
  enabled: boolean,
): CoalesceDecision[] {
  const decisions: CoalesceDecision[] = [];
  const moves: Instr[] = [];
  for (const b of program.blocks) for (const ins of b.instrs) {
    if (ins.isMove && ins.defs.length === 1 && ins.uses.length === 1) moves.push(ins);
  }
  moves.sort((a, b) => a.id.localeCompare(b.id)); // 稳定顺序

  const classK = new Map(program.registerClasses.map((c) => [c.name, c.regs.length]));

  for (const m of moves) {
    const [to] = m.defs; const [from] = m.uses;
    const clsFrom = g.nodeClass.get(from); const clsTo = g.nodeClass.get(to);
    if (clsFrom !== clsTo) {
      decisions.push({ moveId: m.id, from, to, result: 'cross-class-skipped', reason: `寄存器类不同 (${clsFrom} vs ${clsTo})，不得合并` });
      continue;
    }
    if (!enabled) {
      decisions.push({ moveId: m.id, from, to, result: 'kept', reason: '参数 coalescing=false' });
      continue;
    }
    if (g.adj.get(from)?.has(to)) {
      decisions.push({ moveId: m.id, from, to, result: 'kept', reason: '源与目的互相干涉，不能合并' });
      continue;
    }
    const K = classK.get(clsFrom!) ?? 0;
    // George 准则：to 的每个高度邻居都必须已经与 from 相邻
    const ok = [...(g.adj.get(to) ?? [])].every((t) =>
      (g.adj.get(t)?.size ?? 0) < K || g.adj.get(from)?.has(t));
    if (!ok) {
      decisions.push({ moveId: m.id, from, to, result: 'kept', reason: `George 准则不满足 (K=${K})，move 保留` });
      continue;
    }
    // 合并 to 进 from：to 的邻居转接到 from
    for (const t of g.adj.get(to) ?? []) {
      if (t === from) continue;
      g.adj.get(from)!.add(t); g.adj.get(t)!.add(from);
      g.adj.get(t)!.delete(to);
    }
    g.adj.delete(to); g.nodes.delete(to);
    g.precolored.delete(to);
    decisions.push({ moveId: m.id, from, to, result: 'merged', reason: `George 准则满足 (K=${K})，${to} 并入 ${from}` });
  }
  return decisions;
}
