import type {
  AllocationResult,
  AllocatorParams,
  ColorChoice,
  MoveCandidate,
  ProgramMaterial,
  RewriteDifference,
  SimplifyEntry,
  SpillCost,
  LiveRange,
} from "./types.js";
import { analyzeLiveness } from "./liveness.js";
import { buildInterference, type InterferenceGraph } from "./interference.js";
import { coalesce, buildMoves } from "./coalesce.js";
import { computeSpillCosts, rewriteSpills } from "./spill.js";
import { contentHash, sortedUnique } from "./identity.js";
import { diag, CODES } from "./diagnostic.js";

export function inputSummary(program: ProgramMaterial, params: AllocatorParams) {
  const operands = new Set<string>();
  for (const ins of program.instructions)
    for (const op of [...ins.defs, ...ins.uses]) operands.add(op.text);
  return {
    materialHash: contentHash({ p: program, k: params }),
    instructionCount: program.instructions.length,
    blockCount: program.blocks.length,
    operandCount: operands.size,
  };
}

interface WorkGraph {
  graph: InterferenceGraph;
  nodeClass: Map<string, string>;
  fixedColor: Map<string, string>;
  alias: Map<string, string>;
  moves: MoveCandidate[];
}

function buildWorkGraph(program: ProgramMaterial, params: AllocatorParams): WorkGraph {
  const live = analyzeLiveness(program);
  const graph = buildInterference(program, live);
  const moves0 = buildMoves(program);
  const { graph: g2, moves, mergeLog } = coalesce(graph, moves0, params);
  const alias = new Map<string, string>();
  for (const { kept, removed } of mergeLog) alias.set(removed, kept);
  // after merging, class/fixed maps stay keyed on representatives; removed
  // nodes are resolved through alias during select.
  return { graph: g2, nodeClass: live.nodeClass, fixedColor: live.fixedColor, alias, moves };
}

function find(alias: Map<string, string>, n: string): string {
  let cur = n;
  const seen = new Set<string>();
  while (alias.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = alias.get(cur)!;
  }
  return cur;
}

function simplify(wg: WorkGraph, params: AllocatorParams, costs: SpillCost[]): SimplifyEntry[] {
  const { graph, nodeClass, fixedColor } = wg;
  const adj = new Map<string, Set<string>>([...graph.adj].map(([k, v]) => [k, new Set(v)]));
  const removed = new Set<string>();
  const stack: SimplifyEntry[] = [];
  const costByNode = new Map(costs.map((c) => [c.operand, c.cost]));

  const active = (n: string) => !removed.has(n);
  const degree = (n: string) => [...(adj.get(n) ?? [])].filter(active).length;
  let order = 0;

  for (;;) {
    const movable = [...adj.keys()].filter(active).sort();
    if (movable.length === 0) break;
    const low = movable.find(
      (n) => !fixedColor.has(n) && degree(n) < (params.registersPerClass[nodeClass.get(n)!] ?? 0),
    );
    if (low) {
      stack.push({
        order: order++,
        operand: low,
        action: "simplify",
        degreeAtDecision: degree(low),
        candidates: [],
        reason: `degree ${degree(low)} < K=${params.registersPerClass[nodeClass.get(low)!] ?? 0}`,
      });
      removed.add(low);
      continue;
    }
    const remaining = movable.filter((n) => !fixedColor.has(n));
    if (remaining.length === 0) {
      for (const n of movable) {
        stack.push({ order: order++, operand: n, action: "precolor", degreeAtDecision: degree(n), candidates: [], reason: "precolored node" });
        removed.add(n);
      }
      break;
    }
    // Potential spill: minimum cost/degree (high-degree favoured when costs tie).
    const ranked = remaining.slice().sort((a, b) => {
      const ca = (costByNode.get(a) ?? 1) / Math.max(1, degree(a));
      const cb = (costByNode.get(b) ?? 1) / Math.max(1, degree(b));
      if (ca !== cb) return ca - cb;
      if (degree(b) !== degree(a)) return degree(b) - degree(a);
      return a < b ? -1 : 1;
    });
    const pick = ranked[0];
    stack.push({
      order: order++,
      operand: pick,
      action: "spill",
      degreeAtDecision: degree(pick),
      candidates: sortedUnique(remaining),
      reason: `optimistic spill: cost/degree ${((costByNode.get(pick) ?? 1) / Math.max(1, degree(pick))).toFixed(3)} minimal among ${remaining.length} constrained nodes`,
    });
    removed.add(pick);
  }
  return stack;
}

function select(
  wg: WorkGraph,
  stack: SimplifyEntry[],
  program: ProgramMaterial,
  params: AllocatorParams,
): { colors: ColorChoice[]; coloring: Map<string, string | null>; spilled: string[]; infeasible: ColorChoice[] } {
  const { graph, nodeClass, fixedColor, alias } = wg;
  const color = new Map<string, string | null>();
  const colors: ColorChoice[] = [];
  const infeasible: ColorChoice[] = [];

  // Physical registers per class in declared order.
  const physOfClass = new Map(program.registerClasses.map((c) => [c.id, c.members]));

  for (const entry of [...stack].reverse()) {
    const n = entry.operand;
    const rep = find(alias, n);
    const cls = nodeClass.get(rep)!;
    if (fixedColor.has(n)) {
      const phys = fixedColor.get(n)!;
      color.set(n, phys);
      colors.push({ operand: n, physical: phys, registerClass: cls, forbidden: [], legalCandidates: [phys], reason: "precolored" });
      continue;
    }
    const usedByNeighbors = new Set<string>();
    for (const nbRaw of graph.adj.get(rep) ?? []) {
      const nb = find(alias, nbRaw);
      const c = color.get(nb) ?? color.get(nbRaw);
      if (c) usedByNeighbors.add(c);
    }
    const palette = physOfClass.get(cls) ?? [];
    const legal = palette.filter((p) => !usedByNeighbors.has(p));
    const forbidden = palette.filter((p) => usedByNeighbors.has(p));
    if (fixedColor.has(rep)) {
      const phys = fixedColor.get(rep)!;
      color.set(n, phys);
      colors.push({ operand: n, physical: phys, registerClass: cls, forbidden, legalCandidates: [phys], reason: "inherits precolor via coalescing" });
      continue;
    }
    if (legal.length === 0) {
      color.set(n, null);
      const choice: ColorChoice = { operand: n, physical: null, registerClass: cls, forbidden, legalCandidates: [], reason: `all ${palette.length} colors forbidden by interferent neighbors` };
      colors.push(choice);
      infeasible.push(choice);
    } else {
      // Deterministic: first legal in declared order; retain ALL legal candidates.
      const pick = legal[0];
      color.set(n, pick);
      colors.push({ operand: n, physical: pick, registerClass: cls, forbidden, legalCandidates: legal, reason: `first legal of ${legal.length} candidate(s)` });
    }
  }
  const spilled = [...color.entries()].filter(([, v]) => v === null).map(([k]) => k).sort();
  return { colors, coloring: color, spilled, infeasible };
}

function buildLiveRanges(program: ProgramMaterial): LiveRange[] {
  const live = analyzeLiveness(program);
  const ranges = new Map<string, LiveRange>();
  const ensure = (op: string, cls: string): LiveRange => {
    if (!ranges.has(op)) ranges.set(op, { operand: op, registerClass: cls, points: [], edges: [] });
    return ranges.get(op)!;
  };
  for (const ins of program.instructions) {
    for (const op of [...ins.defs, ...ins.uses]) {
      const r = ensure(op.text, op.registerClass);
      const before = live.liveBefore.get(ins.id)?.has(op.text);
      const after = live.liveAfter.get(ins.id)?.has(op.text);
      if (before || after) r.points.push(ins.index);
    }
  }
  for (const [edge, set] of live.phiEdgeLive) {
    for (const op of set) {
      const cls = live.nodeClass.get(op) ?? "";
      const r = ensure(op, cls);
      if (!r.edges.includes(edge)) r.edges.push(edge);
    }
  }
  return [...ranges.values()].map((r) => ({ ...r, points: sortedUnique(r.points.map(String)).map(Number), edges: r.edges.sort() })).sort((a, b) => (a.operand < b.operand ? -1 : 1));
}

export interface AllocationOutcome {
  result: AllocationResult;
  rewritten?: ProgramMaterial;
}

export function allocate(
  program: ProgramMaterial,
  params: AllocatorParams,
  parentId: string | null = null,
): AllocationOutcome {
  const live = analyzeLiveness(program);
  const costs = computeSpillCosts(program, live, params);
  let wg = buildWorkGraph(program, params);
  let stack = simplify(wg, params, costs);
  let sel = select(wg, stack, program, params);

  const diagnostics = [];
  let status: AllocationResult["status"] = sel.spilled.length ? "spilled" : "colored";
  let rewrite: RewriteDifference[] = [];
  let rewritten: ProgramMaterial | undefined;
  let iteration = 0;

  // Spill rewrite loop: after rewriting, rebuild the graph from scratch.
  while (sel.spilled.length > 0) {
    if (iteration >= params.spillBudget) {
      status = "budget-exhausted";
      diagnostics.push(
        diag(CODES.BUDGET_SPILL_EXHAUSTED, `spill budget of ${params.spillBudget} iteration(s) exhausted; ${sel.spilled.length} operand(s) still uncolorable`, {
          category: "budget",
          operand: sel.spilled.join(","),
        }),
      );
      break;
    }
    iteration += 1;
    const rw = rewriteSpills(program, sel.spilled);
    rewritten = rw.material;
    rewrite = rw.differences;
    // IMPORTANT: recompute everything from the rewritten program (new graph).
    const live2 = analyzeLiveness(rewritten);
    const costs2 = computeSpillCosts(rewritten, live2, params);
    wg = buildWorkGraph(rewritten, params);
    stack = simplify(wg, params, costs2);
    const sel2 = select(wg, stack, rewritten, params);
    sel = sel2;
    if (sel.spilled.length === 0) status = "colored";
  }

  // Semantic infeasibility: two nodes pinned to the same physical color and
  // hard-interferent is unresolvable by spilling.
  for (const choice of sel.infeasible) {
    if (wg.fixedColor.has(choice.operand)) status = "semantic-infeasible";
  }
  // Direct precolor-same-color edges that remain are semantic, never repairable.
  if (status !== "budget-exhausted") {
    const pinnedEdges = wg.graph.edges.filter((e) => e.reasonCode === "precolor-same-color");
    if (pinnedEdges.length > 0 && sel.spilled.length > 0) status = "semantic-infeasible";
    for (const e of pinnedEdges) {
      diagnostics.push(
        diag(CODES.SEMANTIC_PRECOLOR_CONFLICT, `'${e.a}' and '${e.b}' are both precolored to the same physical register and interfere`, {
          category: "semantic",
          operand: `${e.a},${e.b}`,
        }),
      );
    }
  }

  const liveFinal = rewritten ? analyzeLiveness(rewritten) : live;
  const liveIn: Record<string, string[]> = {};
  const liveOut: Record<string, string[]> = {};
  for (const b of program.blocks) {
    liveIn[b.label] = sortedUnique(liveFinal.liveIn.get(b.label) ?? []);
    liveOut[b.label] = sortedUnique(liveFinal.liveOut.get(b.label) ?? []);
  }

  const coloring: Record<string, string | null> = {};
  for (const [k, v] of sel.coloring) coloring[k] = v;

  const result: AllocationResult = {
    id: `result_${contentHash({ s: stack.map((x) => x.operand + x.action), c: sel.colors.map((x) => x.operand + x.physical), p: params, h: inputSummary(program, params).materialHash })}`,
    paramsVersion: params.paramsVersion,
    parentId,
    inputSummary: inputSummary(program, params),
    coloring,
    spilled: sel.spilled,
    interferences: wg.graph.edges,
    moves: wg.moves,
    simplifyStack: stack,
    colors: sel.colors.sort((a, b) => (a.operand < b.operand ? -1 : 1)),
    spillCosts: costs.sort((a, b) => a.operand.localeCompare(b.operand)),
    liveRanges: buildLiveRanges(rewritten ?? program),
    liveIn,
    liveOut,
    rewrite,
    diagnostics,
    status,
  };
  return { result, rewritten };
}
