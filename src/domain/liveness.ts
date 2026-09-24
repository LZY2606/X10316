import type { FunctionMaterial, LivenessResult } from './types';

// Liveness where phi uses are charged to the predecessor *edge*, not to the
// phi's own block: a phi use (v, pred=P) makes v live-out of P along the
// P->phi-block edge and does not contribute to the phi block's live-in.
export function computeLiveness(fn: FunctionMaterial): LivenessResult {
  const blocks = fn.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const useB = new Map<string, Set<string>>();
  const defB = new Map<string, Set<string>>();
  const edgeUse = new Map<string, Map<string, Set<string>>>(); // pred -> succ -> vregs

  for (const b of blocks) {
    const use = new Set<string>();
    const def = new Set<string>();
    for (const ins of b.instrs) {
      for (const u of ins.uses) if (!def.has(u.v)) use.add(u.v);
      for (const d of ins.defs) def.add(d.v);
    }
    useB.set(b.id, use);
    defB.set(b.id, def);
    edgeUse.set(b.id, new Map());
  }
  for (const b of blocks) {
    for (const ins of b.instrs) {
      for (const pu of ins.phiUses) {
        const m = edgeUse.get(pu.pred);
        if (!m) continue; // invalid pred already reported by parser
        if (!m.has(b.id)) m.set(b.id, new Set());
        m.get(b.id)!.add(pu.v);
      }
    }
  }

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  for (const b of blocks) {
    liveIn.set(b.id, new Set());
    liveOut.set(b.id, new Set());
  }

  // Deterministic iteration order: sorted block ids, fixed-point sweep.
  const order = blocks.map((b) => b.id).sort();
  let changed = true;
  let guard = 0;
  while (changed && guard < 10000) {
    changed = false;
    guard += 1;
    for (const id of order) {
      const b = byId.get(id)!;
      const out = new Set<string>();
      for (const succ of [...b.succs].sort()) {
        for (const v of liveIn.get(succ) ?? []) out.add(v);
        for (const v of edgeUse.get(id)?.get(succ) ?? []) out.add(v);
      }
      const inn = new Set(useB.get(id));
      for (const v of out) if (!defB.get(id)!.has(v)) inn.add(v);
      if (!setEq(inn, liveIn.get(id)!) || !setEq(out, liveOut.get(id)!)) {
        liveIn.set(id, inn);
        liveOut.set(id, out);
        changed = true;
      }
    }
  }

  const instrLive: LivenessResult['instrLive'] = {};
  const blockResults: LivenessResult['blocks'] = {};
  for (const id of order) {
    const b = byId.get(id)!;
    const live = new Set(liveOut.get(id));
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      const ins = b.instrs[i]!;
      instrLive[ins.id] = {
        liveAfter: [...live].sort(),
        liveBefore: [],
      };
      for (const d of ins.defs) live.delete(d.v);
      for (const u of ins.uses) live.add(u.v);
      instrLive[ins.id]!.liveBefore = [...live].sort();
    }
    const edgeOut: Record<string, string[]> = {};
    for (const succ of [...b.succs].sort()) {
      edgeOut[succ] = [...(edgeUse.get(id)?.get(succ) ?? [])].sort();
    }
    blockResults[id] = {
      liveIn: [...liveIn.get(id)!].sort(),
      liveOut: [...liveOut.get(id)!].sort(),
      edgeOut,
    };
  }
  return { blocks: blockResults, instrLive };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
