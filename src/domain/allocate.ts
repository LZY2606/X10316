import type {
  GraphView,
  Instruction,
  Materials,
  PipelineParams,
  SpillCandidate,
} from './types.js';
import { cmpStr, sortedStrings } from './util.js';
import type { Graph } from './interference.js';
import { spillCost } from './spill.js';
import type { Emit } from './liveness.js';

export type SimplifyResult =
  | { kind: 'done'; stack: string[] }
  | { kind: 'spill'; stack: string[]; spill: { candidates: SpillCandidate[]; victim: string; tied: string[] } }
  | { kind: 'budget' }
  | { kind: 'unsolvable'; reason: string };

const SPILL_TEMP = /\.[rs]\d+_\d+$/;

/** 简化栈：低度节点入栈；全部高度节点时按 代价/度 选溢出受害者，并列时保留全部合法候选。 */
export function simplify(
  graph: Graph,
  materials: Materials,
  params: PipelineParams,
  instrs: Instruction[],
  emit: Emit,
  iteration: number,
): SimplifyResult {
  const removed = new Set<string>();
  const stack: string[] = [];
  const kOf = new Map<string, number>();
  for (const c of materials.classes) kOf.set(c.name, c.regs.length);

  const vregNodes: { node: string; cls: string }[] = [];
  for (const [cls, g] of graph.classes) {
    for (const n of g.adj.keys()) {
      if (!g.regs.includes(n)) vregNodes.push({ node: n, cls });
    }
  }
  vregNodes.sort((a, b) => cmpStr(a.node, b.node));

  const degree = (cls: string, n: string) => {
    let d = 0;
    for (const m of graph.classes.get(cls)!.adj.get(n) ?? []) {
      if (!removed.has(m)) d += 1;
    }
    return d;
  };

  let steps = 0;
  for (;;) {
    steps += 1;
    if (steps > params.simplifyBudget) return { kind: 'budget' };
    const low = vregNodes
      .filter((v) => !removed.has(v.node) && degree(v.cls, v.node) < (kOf.get(v.cls) ?? 0))
      .map((v) => v.node)
      .sort(cmpStr)[0];
    if (low !== undefined) {
      removed.add(low);
      stack.push(low);
      continue;
    }
    const remaining = vregNodes.filter((v) => !removed.has(v.node));
    if (remaining.length === 0) return { kind: 'done', stack };

    for (const v of remaining) {
      emit(iteration, 'high_degree_node',
        `节点 ${v.node} 在类 ${v.cls} 中度 ${degree(v.cls, v.node)} ≥ K=${kOf.get(v.cls)}`,
        { node: v.node, cls: v.cls, degree: degree(v.cls, v.node), k: kOf.get(v.cls) });
    }

    const candidates: SpillCandidate[] = remaining.map((v) => ({
      node: v.node,
      cls: v.cls,
      degree: degree(v.cls, v.node),
      cost: spillCost(v.node, instrs, materials, params, emit, iteration),
    }));
    const determinate = candidates.filter((c) => c.cost.value !== null && c.degree > 0 && !SPILL_TEMP.test(c.node));
    if (determinate.length === 0) {
      return {
        kind: 'unsolvable',
        reason: candidates.some((c) => SPILL_TEMP.test(c.node))
          ? '溢出重写产生的临时 vreg 仍然高度，重写后仍无法着色'
          : '剩余候选的溢出代价均无法确定（存在不可转换单位），不能伪造决策',
      };
    }
    let best = determinate[0];
    const ratio = (c: SpillCandidate) => (c.cost.value as number) / c.degree;
    for (const c of determinate) {
      if (ratio(c) < ratio(best) || (ratio(c) === ratio(best) && cmpStr(c.node, best.node) < 0)) best = c;
    }
    const tied = determinate.filter((c) => ratio(c) === ratio(best)).map((c) => c.node).sort(cmpStr);
    emit(iteration, 'spill_choice',
      `按 代价/度 选择溢出 ${best.node}（${best.cost.raw} / degree ${best.degree}）`,
      {
        victim: best.node,
        cost: best.cost,
        degree: best.degree,
        tied,
        allCandidates: candidates.map((c) => ({ node: c.node, cost: c.cost.raw, degree: c.degree })),
      });
    if (tied.length > 1) {
      emit(iteration, 'spill_candidates_tied',
        `溢出代价并列，保留全部合法候选: ${tied.join(', ')}（确定地选取 ${best.node}）`,
        { tied, allCandidates: tied });
    }
    return { kind: 'spill', stack, spill: { candidates, victim: best.node, tied } };
  }
}

/** 按简化栈逆序选色；预着色 vreg 固定到物理寄存器。 */
export function colorGraph(
  graph: Graph,
  stack: string[],
  materials: Materials,
  precolorMap: Map<string, string>,
): { coloring: { vreg: string; color: string; cls: string }[] } | { failure: string } {
  const colorOf = new Map<string, string>();
  for (const [cls, g] of graph.classes) for (const r of g.regs) colorOf.set(`${cls}:${r}`, r);

  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const n = stack[idx];
    const cls = graph.vregClass.get(n);
    if (!cls) return { failure: `节点 ${n} 缺少寄存器类` };
    const g = graph.classes.get(cls)!;
    const used = new Set<string>();
    for (const m of g.adj.get(n) ?? []) {
      if (g.regs.includes(m)) {
        used.add(m);
      } else if (colorOf.has(m)) {
        used.add(colorOf.get(m)!);
      }
    }
    const free = g.regs.filter((r) => !used.has(r));
    if (free.length === 0) return { failure: `节点 ${n} 在类 ${cls} 中无可用物理寄存器` };
    colorOf.set(n, free[0]);
  }
  for (const [v, phys] of precolorMap) colorOf.set(v, phys);

  const coloring = [...graph.vregClass.entries()]
    .filter(([n]) => !materials.classes.some((c) => c.regs.includes(n)))
    .map(([vreg, cls]) => ({ vreg, color: colorOf.get(vreg) ?? '?', cls }))
    .sort((a, b) => cmpStr(a.vreg, b.vreg));
  return { coloring };
}

export function graphViews(graph: Graph): GraphView[] {
  const views: GraphView[] = [];
  for (const [cls, g] of graph.classes) {
    const edgeSet = new Set<string>();
    for (const [a, neighbors] of g.adj) {
      for (const b of neighbors) {
        const key = [a, b].sort(cmpStr).join('--');
        edgeSet.add(key);
      }
    }
    views.push({
      className: cls,
      k: g.regs.length,
      nodes: [...g.adj.keys()]
        .sort(cmpStr)
        .map((id) => ({
          id,
          kind: g.regs.includes(id) ? ('phys' as const) : ('vreg' as const),
          degree: g.adj.get(id)!.size,
        })),
      edges: [...edgeSet].sort().map((e) => e.split('--') as [string, string]),
    });
  }
  return views.sort((a, b) => cmpStr(a.className, b.className));
}

export { sortedStrings };
