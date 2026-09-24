import type { BlockLiveness, FunctionIR, TraceEvent } from '../shared/types.js';

export interface LivenessResult {
  blocks: BlockLiveness[];
  liveIn: Map<string, Set<string>>;
  liveOut: Map<string, Set<string>>;
  edgeLive: Map<string, Set<string>>; // "pred->succ" -> vregs live on that edge
  events: TraceEvent[];
}

// Backward dataflow. Phi uses are charged to the predecessor *edge*
// (liveOut of the named predecessor), never to liveIn of the phi's block.
export function computeLiveness(ir: FunctionIR): LivenessResult {
  const events: TraceEvent[] = [];
  const use = new Map<string, Set<string>>();
  const def = new Map<string, Set<string>>();
  const edgeUse = new Map<string, Set<string>>(); // "pred->block"
  const phiDefs = new Map<string, Set<string>>();

  for (const b of ir.blocks) {
    const u = new Set<string>();
    const d = new Set<string>();
    const pd = new Set<string>();
    for (const ins of b.instrs) {
      if (ins.kind === 'phi') {
        d.add(ins.def.vreg);
        pd.add(ins.def.vreg);
        for (const s of ins.sources) {
          const key = `${s.pred}->${b.id}`;
          if (!edgeUse.has(key)) edgeUse.set(key, new Set());
          edgeUse.get(key)!.add(s.vreg);
          events.push({
            type: 'phi_edge_use',
            detail: { phi: ins.id, vreg: s.vreg, edge: key, countedIn: `liveOut[${s.pred}]` },
          });
        }
      } else {
        for (const o of ins.uses) if (!d.has(o.vreg)) u.add(o.vreg);
        for (const o of ins.defs) d.add(o.vreg);
      }
    }
    use.set(b.id, u);
    def.set(b.id, d);
    phiDefs.set(b.id, pd);
  }

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  for (const b of ir.blocks) {
    liveIn.set(b.id, new Set());
    liveOut.set(b.id, new Set());
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of [...ir.blocks].reverse()) {
      const out = new Set<string>();
      for (const s of b.succs) {
        const key = `${b.id}->${s}`;
        const succIn = liveIn.get(s)!;
        const succPhi = phiDefs.get(s)!;
        // successor liveIn minus its phi defs flows onto this edge
        for (const v of succIn) if (!succPhi.has(v)) out.add(v);
        for (const v of edgeUse.get(key) ?? []) out.add(v);
      }
      const inn = new Set(use.get(b.id)!);
      for (const v of out) if (!def.get(b.id)!.has(v)) inn.add(v);
      if (!setEq(out, liveOut.get(b.id)!)) {
        liveOut.set(b.id, out);
        changed = true;
      }
      if (!setEq(inn, liveIn.get(b.id)!)) {
        liveIn.set(b.id, inn);
        changed = true;
      }
    }
  }

  const edgeLive = new Map<string, Set<string>>();
  for (const b of ir.blocks)
    for (const s of b.succs) {
      const key = `${b.id}->${s}`;
      const live = new Set<string>();
      const succPhi = phiDefs.get(s)!;
      for (const v of liveIn.get(s)!) if (!succPhi.has(v)) live.add(v);
      for (const v of edgeUse.get(key) ?? []) live.add(v);
      edgeLive.set(key, live);
    }

  const blocks: BlockLiveness[] = ir.blocks.map((b) => ({
    block: b.id,
    liveIn: [...liveIn.get(b.id)!].sort(),
    liveOut: [...liveOut.get(b.id)!].sort(),
    edgeLive: b.succs.map((s) => ({
      edge: `${b.id}->${s}`,
      live: [...edgeLive.get(`${b.id}->${s}`)!].sort(),
    })),
  }));
  return { blocks, liveIn, liveOut, edgeLive, events };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
