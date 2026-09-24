import type { AllocatorParams, MoveCandidate, ProgramMaterial } from "./types.js";
import type { InterferenceGraph } from "./interference.js";

/** Build move candidates with explicit same-class check (cross-class never merges). */
export function buildMoves(program: ProgramMaterial): MoveCandidate[] {
  const moves: MoveCandidate[] = [];
  for (const ins of program.instructions) {
    if (!ins.isMove || ins.defs.length !== 1 || ins.uses.length !== 1) continue;
    const dst = ins.defs[0];
    const src = ins.uses[0];
    const sameClass = dst.registerClass === src.registerClass;
    moves.push({
      id: `move_i${ins.index}`,
      moveIndex: ins.index,
      src: src.text,
      dst: dst.text,
      srcClass: src.registerClass,
      dstClass: dst.registerClass,
      sameClass,
      coalesced: false,
      decision: "pending",
      reason: sameClass ? undefined : `cross-class move ${src.registerClass} -> ${dst.registerClass}; never coalesced`,
    });
  }
  return moves.sort((a, b) => a.moveIndex - b.moveIndex);
}

/** Briggs conservative coalescing over a working copy of the graph. */
export function coalesce(
  graph: InterferenceGraph,
  moves: MoveCandidate[],
  params: AllocatorParams,
): { graph: InterferenceGraph; moves: MoveCandidate[]; mergeLog: Array<{ kept: string; removed: string }> } {
  if (params.coalescing === "off") {
    return { graph, moves: moves.map((m) => (m.sameClass ? m : { ...m, decision: "rejected" as const })), mergeLog: [] };
  }
  const adj = new Map<string, Set<string>>([...graph.adj].map(([k, v]) => [k, new Set(v)]));
  const alias = new Map<string, string>();
  const find = (n: string): string => (alias.has(n) ? find(alias.get(n)!) : n);
  const mergeLog: Array<{ kept: string; removed: string }> = [];
  const working = moves.map((m) => ({ ...m }));

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of working) {
      if (m.decision !== "pending") continue;
      if (!m.sameClass) {
        m.decision = "rejected";
        m.reason = `cross-class move (${m.srcClass} vs ${m.dstClass}); cannot merge different register classes`;
        changed = true;
        continue;
      }
      const a = find(m.src);
      const b = find(m.dst);
      if (a === b) {
        m.decision = "accepted";
        m.coalesced = true;
        m.reason = "already unified";
        changed = true;
        continue;
      }
      const union = new Set<string>([...(adj.get(a) ?? []), ...(adj.get(b) ?? [])]);
      union.delete(a);
      union.delete(b);
      const k = params.registersPerClass[m.dstClass] ?? 0;
      let significant = 0;
      for (const n of union) {
        const na = adj.get(n);
        if (na && na.size >= k) significant += 1;
      }
      if (significant < k) {
        const keep = a < b ? a : b;
        const drop = keep === a ? b : a;
        const neigh = new Set([...(adj.get(a) ?? []), ...(adj.get(b) ?? [])]);
        neigh.delete(keep);
        neigh.delete(drop);
        adj.set(keep, neigh);
        for (const n of neigh) {
          const s = adj.get(n)!;
          s.delete(drop);
          s.add(keep);
        }
        adj.delete(drop);
        alias.set(drop, keep);
        mergeLog.push({ kept: keep, removed: drop });
        m.decision = "accepted";
        m.coalesced = true;
        m.reason = `Briggs conservative merge: ${significant} significant neighbours < K=${k}`;
        changed = true;
      } else {
        m.decision = "rejected";
        m.reason = `coalescing failed: ${significant} high-degree neighbours >= K=${k}; move retained`;
        changed = true;
      }
    }
  }

  const edges = [];
  const seen = new Set<string>();
  for (const [n, ns] of adj) {
    for (const o of ns) {
      const id = [n, o].sort().join("|");
      if (seen.has(id)) continue;
      seen.add(id);
      const [x, y] = id.split("|");
      const old = graph.edgeById.get(id);
      edges.push(old ?? { id, a: x, b: y, reason: "post-coalesce adjacency", reasonCode: "coalesced", at: "coalesce" });
    }
  }
  edges.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return { graph: { adj, edges, edgeById: graph.edgeById }, moves: working, mergeLog };
}
