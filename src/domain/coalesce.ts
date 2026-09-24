import type { CoalesceResult, InterferenceGraph } from './types';

// Briggs conservative coalescing. A failed coalesce NEVER deletes the move:
// the instruction stays in the stream and the pair is recorded as a kept
// move edge. Cross-class moves are never coalescible.
export function coalesce(
  graph: InterferenceGraph,
  rule: 'briggs',
  classSizes: Record<string, number>,
): CoalesceResult {
  const alias = new Map<string, string>();
  const decisions: CoalesceResult['decisions'] = [];
  const keptMoves: string[] = [];
  const find = (v: string): string => {
    let r = v;
    while (alias.has(r)) r = alias.get(r)!;
    return r;
  };

  const adjacency = new Map<string, Set<string>>();
  for (const [a, b] of graph.edges) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const mv of graph.moveEdges) {
    const a = find(mv.a);
    const b = find(mv.b);
    if (a === b) continue;
    const na = nodeById.get(a);
    const nb = nodeById.get(b);
    if (!na || !nb) continue;
    if (mv.crossClass || na.class !== nb.class) {
      keptMoves.push(mv.instr);
      decisions.push({
        instr: mv.instr, a, b, rule, mergedDegree: null, k: 0,
        result: 'kept',
        reason: 'cross-class move: register classes must not be merged; move preserved',
      });
      continue;
    }
    if (adjacency.get(a)?.has(b)) {
      keptMoves.push(mv.instr);
      decisions.push({
        instr: mv.instr, a, b, rule, mergedDegree: null, k: 0,
        result: 'kept', reason: 'move pair interferes; not coalescible',
      });
      continue;
    }
    const k = classSizes[na.class] ?? 0;
    const merged = new Set([...(adjacency.get(a) ?? []), ...(adjacency.get(b) ?? [])]);
    merged.delete(a);
    merged.delete(b);
    let significant = 0;
    for (const n of merged) {
      const node = nodeById.get(n);
      if (node && (node.precolored || node.degree >= k)) significant += 1;
    }
    if (significant < k) {
      // Merge (deterministic: lexicographically smaller id survives).
      const [keep, drop] = a < b ? [a, b] : [b, a];
      alias.set(drop, keep);
      for (const n of adjacency.get(drop) ?? []) {
        if (n === keep) continue;
        adjacency.get(keep)?.add(n);
        adjacency.get(n)?.delete(drop);
        adjacency.get(n)?.add(keep);
      }
      adjacency.delete(drop);
      decisions.push({
        instr: mv.instr, a, b, rule, mergedDegree: significant, k,
        result: 'coalesced',
        reason: `briggs: merged significant-degree neighbours ${significant} < K=${k}`,
      });
    } else {
      keptMoves.push(mv.instr);
      decisions.push({
        instr: mv.instr, a, b, rule, mergedDegree: significant, k,
        result: 'kept',
        reason: `briggs: merged significant-degree neighbours ${significant} >= K=${k}; move preserved`,
      });
    }
  }
  const aliasObj: Record<string, string> = {};
  for (const n of graph.nodes) {
    const r = find(n.id);
    if (r !== n.id) aliasObj[n.id] = r;
  }
  return { alias: aliasObj, decisions, keptMoves };
}
