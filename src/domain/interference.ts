import type { FunctionMaterial, GraphNode, InterferenceGraph, LivenessResult } from './types';
import { quantity } from './units';

export interface InterferenceOptions {
  loopWeightBase: number;
  loopWeightExponent: number;
}

// Builds the interference graph. Nodes are keyed by vreg *and* register class
// so different classes never share a node; precolored physical registers are
// nodes of their own class. Cross-class moves become move edges flagged
// non-coalescible instead of merging anything.
export function buildInterference(
  fn: FunctionMaterial,
  live: LivenessResult,
  opts: InterferenceOptions,
): InterferenceGraph {
  const classOf = new Map<string, string>();
  const weightOfBlock = new Map<string, number>();
  for (const b of fn.blocks) {
    weightOfBlock.set(b.id, Math.pow(opts.loopWeightBase, b.loopDepth * opts.loopWeightExponent));
  }
  for (const b of fn.blocks) {
    for (const ins of b.instrs) {
      for (const r of [...ins.defs, ...ins.uses]) classOf.set(r.v, r.class);
      for (const pu of ins.phiUses) {
        if (!classOf.has(pu.v)) {
          const d = fn.blocks.flatMap((x) => x.instrs).find((i) => i.defs.some((dd) => dd.v === pu.v));
          if (d) classOf.set(pu.v, d.defs.find((dd) => dd.v === pu.v)!.class);
        }
      }
    }
  }

  const edges = new Set<string>();
  const moveEdges: InterferenceGraph['moveEdges'] = [];
  const spillCost = new Map<string, number>();
  const addCost = (v: string, blockId: string, amount: number) => {
    spillCost.set(v, (spillCost.get(v) ?? 0) + amount * (weightOfBlock.get(blockId) ?? 1));
  };
  const edgeKey = (a: string, b: string) => (a < b ? `${a}${b}` : `${b}${a}`);
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    // Different classes use disjoint register files: no interference edge.
    if (classOf.get(a) && classOf.get(b) && classOf.get(a) !== classOf.get(b)) return;
    edges.add(edgeKey(a, b));
  };

  // Physical registers are precolored nodes of their class.
  for (const rc of fn.regClasses) {
    for (const p of rc.regs) classOf.set(p, rc.id);
  }

  for (const b of fn.blocks) {
    const liveSet = new Set(live.blocks[b.id]!.liveOut);
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      const ins = b.instrs[i]!;
      // Call clobbers: every vreg live across the call interferes with each
      // clobbered physical register of the same class.
      for (const p of ins.clobbers) {
        for (const v of liveSet) addEdge(v, p);
      }
      const moveSrc = ins.move && ins.uses.length === 1 ? ins.uses[0]!.v : null;
      for (const d of ins.defs) {
        addCost(d.v, b.id, ins.cost?.value ?? 1);
        for (const v of liveSet) {
          if (v === d.v) continue;
          if (moveSrc && v === moveSrc && ins.defs.length === 1) continue; // move-related pair
          addEdge(d.v, v);
        }
      }
      if (ins.move && ins.defs.length === 1 && ins.uses.length === 1) {
        moveEdges.push({
          a: ins.defs[0]!.v,
          b: ins.uses[0]!.v,
          instr: ins.id,
          crossClass: ins.crossClass || classOf.get(ins.defs[0]!.v) !== classOf.get(ins.uses[0]!.v),
        });
      }
      for (const d of ins.defs) liveSet.delete(d.v);
      for (const u of ins.uses) {
        liveSet.add(u.v);
        addCost(u.v, b.id, ins.cost?.value ?? 1);
      }
    }
  }

  const nodes: GraphNode[] = [...classOf.keys()].sort().map((id) => {
    const isPreg = fn.regClasses.some((rc) => rc.regs.includes(id));
    const cost = spillCost.get(id) ?? 0;
    return {
      id,
      class: classOf.get(id)!,
      precolored: isPreg,
      color: isPreg ? id : null,
      spillCost: quantity(cost, 'cycle', `loopWeightBase^loopDepth*exponent=${opts.loopWeightExponent}`),
      degree: 0,
    };
  });
  const degree = new Map<string, number>();
  for (const e of edges) {
    const [a, b] = e.split('') as [string, string];
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
  const edgeList: Array<[string, string]> = [...edges]
    .sort()
    .map((e) => e.split('') as [string, string]);
  return { nodes, edges: edgeList, moveEdges };
}
