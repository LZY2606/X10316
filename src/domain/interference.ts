import type { Instruction, Materials } from './types.js';
import type { Emit, LivenessResult } from './liveness.js';

export interface Graph {
  classes: Map<string, ClassGraph>;
  conflicts: { a: string; b: string; phys: string }[];
  vregClass: Map<string, string>;
}

export interface ClassGraph {
  regs: string[];
  adj: Map<string, Set<string>>;
}

export function emptyGraph(materials: Materials): Graph {
  const classes = new Map<string, ClassGraph>();
  for (const c of materials.classes) {
    const adj = new Map<string, Set<string>>();
    for (const r of c.regs) adj.set(r, new Set());
    classes.set(c.name, { regs: [...c.regs], adj });
  }
  return { classes, conflicts: [], vregClass: new Map() };
}

/** 干涉图按寄存器类分别构建；预着色 vreg 别名到物理节点，冲突成对记录。 */
export function buildGraph(
  materials: Materials,
  instrs: Instruction[],
  live: LivenessResult,
  precolorMap: Map<string, string>,
  pendingMoves: Set<string>,
  emit: Emit,
  iteration: number,
): Graph {
  const graph = emptyGraph(materials);
  for (const i of instrs) {
    for (const o of [...i.defs, ...i.uses]) graph.vregClass.set(o.name, o.cls);
  }
  const alias = (v: string) => precolorMap.get(v) ?? v;
  const ensure = (cls: string, n: string) => {
    const g = graph.classes.get(cls)!;
    if (!g.adj.has(n)) g.adj.set(n, new Set());
  };
  const addEdge = (rawA: string, rawB: string, cls: string) => {
    const a = alias(rawA);
    const b = alias(rawB);
    if (a === b) {
      if (rawA !== rawB) graph.conflicts.push({ a: rawA, b: rawB, phys: a });
      return;
    }
    ensure(cls, a);
    ensure(cls, b);
    graph.classes.get(cls)!.adj.get(a)!.add(b);
    graph.classes.get(cls)!.adj.get(b)!.add(a);
  };

  const byBlock = new Map<string, Instruction[]>();
  for (const i of instrs) {
    if (!byBlock.has(i.block)) byBlock.set(i.block, []);
    byBlock.get(i.block)!.push(i);
  }
  for (const list of byBlock.values()) list.sort((a, b) => a.order - b.order);

  for (const b of materials.blocks) {
    for (const i of byBlock.get(b.name) ?? []) {
      const after = [...(live.liveAfter.get(i.id) ?? [])];
      if (i.call) {
        emit(iteration, 'call_clobber_interference',
          `调用 ${i.id} 的 clobber {${i.clobbers.join(', ')}} 与跨调用活跃值发生干涉`,
          { instr: i.id, clobbers: [...i.clobbers], liveAcross: [...after].sort() });
        for (const p of i.clobbers) {
          const cls = materials.classes.find((c) => c.regs.includes(p))!.name;
          for (const v of after) {
            if (graph.vregClass.get(v) === cls) addEdge(p, v, cls);
          }
        }
      }
      const moveCandidate =
        i.op === 'move' && i.move && pendingMoves.has(i.id) && i.move.fromClass === i.move.toClass;
      for (const df of i.defs) {
        for (const v of after) {
          if (moveCandidate && i.move && v === i.move.from) continue;
          if (graph.vregClass.get(v) === df.cls) addEdge(df.name, v, df.cls);
        }
      }
    }
  }

  for (const [vreg, cls] of graph.vregClass) ensure(cls, alias(vreg));
  return graph;
}

export function graphHasEdge(graph: Graph, cls: string, a: string, b: string): boolean {
  return graph.classes.get(cls)!.adj.get(a)?.has(b) ?? false;
}

/** Briggs 保守合并：合并后显著度（>=K）邻居少于 K 才允许 coalesce。 */
export function briggsOk(graph: Graph, cls: string, a: string, b: string, k: number): boolean {
  const g = graph.classes.get(cls)!;
  const na = g.adj.get(a) ?? new Set<string>();
  const nb = g.adj.get(b) ?? new Set<string>();
  const merged = new Set<string>([...na, ...nb]);
  merged.delete(a);
  merged.delete(b);
  let significant = 0;
  for (const n of merged) {
    if ((g.adj.get(n)?.size ?? 0) >= k) significant += 1;
  }
  return significant < k;
}
