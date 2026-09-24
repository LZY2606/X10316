import type { Program, Quantity } from './types';
import type { InterferenceGraph } from './interference';
import type { LivenessResult } from './liveness';

// 简化 + 选择。高度节点（degree >= K）按溢出代价/度选择；
// 预着色冲突 => 语义无解（第三种独立结果）。

export interface SimplifyEntry { node: string; reason: 'low-degree' | 'spill-metric'; degree: number; k: number }
export interface SelectResult {
  colors: Record<string, string>;
  spilled: string[];
  stack: SimplifyEntry[];
  budgetExhausted: boolean;
  conflicts: { a: string; b: string; preg: string }[];
}

export function spillCostOf(
  program: Program, live: LivenessResult, vreg: string,
): Quantity {
  const manual = program.vregs[vreg]?.spillCost;
  if (manual) return manual; // 人工标注的原始表示优先，派生层不覆盖
  let total = 0;
  for (const b of program.blocks) {
    const w = live.blockWeight.get(b.id)?.value ?? 1;
    for (const ins of b.instrs) {
      if (ins.defs.includes(vreg)) total += w;
      if (ins.uses.includes(vreg)) total += w;
      // phi 边使用按前驱块权重计入
      if (ins.op === 'phi') for (const a of ins.phiArgs ?? []) {
        if (a.vreg === vreg) total += live.blockWeight.get(a.pred)?.value ?? 1; // 边使用按前驱块权重
      }
    }
  }
  return { value: total, unit: 'spill-cost', basis: 'static-loop-weight' };
}

export function simplifyAndSelect(
  program: Program,
  g0: InterferenceGraph,
  live: LivenessResult,
  simplifyBudget: number,
): SelectResult {
  // 复制图（简化过程是破坏性的）
  const adj = new Map<string, Set<string>>();
  for (const [n, s] of g0.adj) adj.set(n, new Set(s));
  const inGraph = new Set(g0.nodes);
  const classK = new Map(program.registerClasses.map((c) => [c.name, c.regs.length]));
  const classRegs = new Map(program.registerClasses.map((c) => [c.name, c.regs]));

  // 预着色冲突检测：预着色节点与其目标 preg 相邻，或两个同 preg 的预着色节点相邻
  const conflicts: { a: string; b: string; preg: string }[] = [];
  for (const [v, preg] of g0.precolored) {
    if (v === preg) continue;
    if (adj.get(v)?.has(preg)) conflicts.push({ a: v, b: preg, preg });
  }
  const pre = [...g0.precolored.entries()].filter(([v, p]) => v !== p);
  for (let i = 0; i < pre.length; i++) for (let j = i + 1; j < pre.length; j++) {
    if (pre[i][1] === pre[j][1] && adj.get(pre[i][0])?.has(pre[j][0])) {
      conflicts.push({ a: pre[i][0], b: pre[j][0], preg: pre[i][1] });
    }
  }
  if (conflicts.length) return { colors: {}, spilled: [], stack: [], budgetExhausted: false, conflicts };

  const stack: SimplifyEntry[] = [];
  let budget = simplifyBudget;
  let budgetExhausted = false;

  const isAllocatable = (n: string) => !g0.precolored.has(n) && !classRegs.get(g0.nodeClass.get(n)!)?.includes(n);

  for (;;) {
    if (budget <= 0) { budgetExhausted = true; break; }
    budget--;
    const remaining = [...inGraph].filter(isAllocatable).sort();
    if (!remaining.length) break;
    let picked: string | null = null;
    for (const n of remaining) {
      const k = classK.get(g0.nodeClass.get(n)!) ?? 0;
      const deg = [...(adj.get(n) ?? [])].filter((t) => inGraph.has(t)).length;
      if (deg < k) { picked = n; stack.push({ node: n, reason: 'low-degree', degree: deg, k }); break; }
    }
    if (!picked) {
      // 高度节点：按 spill cost / degree 选最小者
      let best: string | null = null; let bestMetric = Infinity; let bestDeg = 0;
      for (const n of remaining) {
        const deg = [...(adj.get(n) ?? [])].filter((t) => inGraph.has(t)).length;
        const cost = spillCostOf(program, live, n).value;
        const metric = cost / Math.max(deg, 1);
        if (metric < bestMetric || (metric === bestMetric && best !== null && n < best)) {
          best = n; bestMetric = metric; bestDeg = deg;
        }
      }
      picked = best!;
      stack.push({ node: picked, reason: 'spill-metric', degree: bestDeg, k: classK.get(g0.nodeClass.get(picked)!) ?? 0 });
    }
    inGraph.delete(picked);
  }

  // 选择阶段：逆序弹出，分配同类中最低空闲 preg
  const colors: Record<string, string> = {};
  for (const [v, p] of g0.precolored) colors[v] = p;
  const spilled: string[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i].node;
    inGraph.add(n);
    const cls = g0.nodeClass.get(n)!;
    const used = new Set<string>();
    for (const t of adj.get(n) ?? []) {
      if (!inGraph.has(t)) continue;
      const c = colors[t] ?? (g0.precolored.get(t) as string | undefined);
      if (c) used.add(c);
    }
    const free = (classRegs.get(cls) ?? []).find((r) => !used.has(r));
    if (free) colors[n] = free;
    else spilled.push(n); // 实际溢出
  }
  spilled.sort();
  return { colors, spilled, stack, budgetExhausted, conflicts: [] };
}
