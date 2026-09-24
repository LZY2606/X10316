import type { ColorResult, Diagnostic, FunctionMaterial, InterferenceGraph, ParamSet, SimplifyStep } from './types';

export interface ColorOutcome {
  status: 'ok' | 'unsatisfiable' | 'budget_exhausted';
  diagnostics: Diagnostic[];
  result?: ColorResult;
}

// Chaitin-style simplify/select with optimistic spilling. Precolor conflicts
// (two interfering nodes pinned to the same physical register, or a pinned
// vreg interfering with its own pinned color via clobbers) are reported as
// `unsatisfiable` with positions — never silently recolored.
export function colorGraph(
  fn: FunctionMaterial,
  graph: InterferenceGraph,
  alias: Record<string, string>,
  params: ParamSet,
): ColorOutcome {
  const diagnostics: Diagnostic[] = [];
  const rep = (v: string) => alias[v] ?? v;

  // Positions of each vreg's first def, for diagnostics.
  const positionOf = new Map<string, string>();
  for (const b of fn.blocks) {
    for (const ins of b.instrs) {
      for (const d of ins.defs) if (!positionOf.has(d.v)) positionOf.set(d.v, ins.coord);
    }
  }

  // Merge graph under coalescing alias.
  const nodes = new Map<string, { id: string; class: string; precolored: boolean; color: string | null; spillCost: number }>();
  const adj = new Map<string, Set<string>>();
  const classSizes = new Map<string, number>();
  for (const rc of fn.regClasses) classSizes.set(rc.id, rc.regs.length);
  for (const n of graph.nodes) {
    const id = rep(n.id);
    if (!nodes.has(id)) {
      nodes.set(id, { id, class: n.class, precolored: n.precolored, color: n.color, spillCost: n.spillCost.value ?? 0 });
      adj.set(id, new Set());
    } else {
      const cur = nodes.get(id)!;
      cur.spillCost += n.spillCost.value ?? 0;
      if (n.precolored) {
        if (cur.precolored && cur.color !== n.color) {
          diagnostics.push({
            position: positionOf.get(id) ?? '$',
            severity: 'error',
            message: `coalescing merged two precolored nodes with different colors (${cur.color} vs ${n.color})`,
          });
        }
        cur.precolored = true;
        cur.color = cur.color ?? n.color;
      }
    }
  }
  for (const [a, b] of graph.edges) {
    const ra = rep(a);
    const rb = rep(b);
    if (ra === rb) continue;
    adj.get(ra)?.add(rb);
    adj.get(rb)?.add(ra);
  }

  // Precolor conflict check (unsatisfiable, with positions).
  const precolorOf = new Map<string, string>();
  for (const b of fn.blocks) {
    for (const ins of b.instrs) {
      for (const [v, p] of Object.entries(ins.precolor)) precolorOf.set(v, p);
    }
  }
  for (const n of nodes.values()) {
    const pinned = n.precolored ? n.color : precolorOf.get(n.id);
    if (pinned) {
      n.precolored = true;
      n.color = pinned;
    }
  }
  for (const [id, neighbors] of adj) {
    const a = nodes.get(id)!;
    if (!a.precolored || !a.color) continue;
    for (const nb of neighbors) {
      const b = nodes.get(nb)!;
      if (b.precolored && b.color === a.color && id < nb) {
        diagnostics.push({
          position: positionOf.get(nb) ?? positionOf.get(id) ?? '$',
          severity: 'error',
          message: `precolor conflict: ${id} and ${nb} both pinned to ${a.color} but interfere`,
        });
      }
    }
  }
  if (diagnostics.length > 0) return { status: 'unsatisfiable', diagnostics };

  // Simplify.
  const stack: SimplifyStep[] = [];
  const removed = new Set<string>();
  const workAdj = new Map([...adj.entries()].map(([k, v]) => [k, new Set(v)]));
  const degreeOf = (id: string) => {
    let d = 0;
    for (const n of workAdj.get(id) ?? []) if (!removed.has(n)) d += 1;
    return d;
  };
  const spilled: string[] = [];
  let steps = 0;
  const remaining = () => [...nodes.keys()].filter((id) => !removed.has(id) && !nodes.get(id)!.precolored);
  for (;;) {
    if (steps++ > params.budget.maxSimplifySteps) {
      return {
        status: 'budget_exhausted',
        diagnostics: [{ position: 'simplify', severity: 'error', message: `simplify step budget ${params.budget.maxSimplifySteps} exhausted` }],
      };
    }
    const rem = remaining();
    if (rem.length === 0) break;
    let progressed = false;
    for (const id of [...rem].sort()) {
      const k = classSizes.get(nodes.get(id)!.class) ?? 0;
      if (degreeOf(id) < k) {
        stack.push({ node: id, action: 'push', reason: `degree ${degreeOf(id)} < K=${k}`, degree: degreeOf(id) });
        removed.add(id);
        progressed = true;
      }
    }
    if (progressed) continue;
    // Spill candidate: lowest spillCost/degree among remaining (deterministic tie-break by id).
    let best: string | null = null;
    let bestRatio = Infinity;
    for (const id of [...rem].sort()) {
      const n = nodes.get(id)!;
      const d = Math.max(degreeOf(id), 1);
      const ratio = n.spillCost / d;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = id;
      }
    }
    const id = best!;
    stack.push({ node: id, action: 'spill_candidate', reason: `no node with degree < K; spill candidate cost/degree=${bestRatio.toFixed(3)}`, degree: degreeOf(id) });
    removed.add(id);
  }

  // Select.
  const assignments: Record<string, string> = {};
  for (const n of nodes.values()) if (n.precolored && n.color) assignments[n.id] = n.color;
  const classRegs = new Map(fn.regClasses.map((rc) => [rc.id, rc.regs]));
  for (let i = stack.length - 1; i >= 0; i--) {
    const step = stack[i]!;
    const id = step.node;
    removed.delete(id);
    const n = nodes.get(id)!;
    const used = new Set<string>();
    for (const nb of adj.get(id) ?? []) {
      if (!removed.has(nb) && assignments[nb]) used.add(assignments[nb]!);
    }
    const avail = (classRegs.get(n.class) ?? []).filter((r) => !used.has(r));
    if (avail.length === 0) {
      spilled.push(id);
    } else {
      assignments[id] = avail[0]!;
    }
  }
  return {
    status: 'ok',
    diagnostics,
    result: {
      assignments,
      spills: spilled.sort(),
      simplifyStack: stack,
      conflicts: [],
    },
  };
}
