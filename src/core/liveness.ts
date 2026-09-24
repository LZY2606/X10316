/**
 * Liveness with phi uses attributed to predecessor EDGES.
 * A phi use of v from predecessor P makes v live-out of P (on edge P->phiBlock),
 * never live-in of the phi block. All sets are deterministically ordered.
 */
import { Block, BlockId, computePreds, Phi, Program, VReg } from "./ir.js";
import { blockWeight, Quantity } from "./units.js";

export interface LivenessResult {
  run: number;
  liveIn: Record<BlockId, VReg[]>;
  liveOut: Record<BlockId, VReg[]>;
  /** per-edge phi uses: edgeUses["P->S"] = vregs used by phis in S along that edge */
  edgeUses: Record<string, VReg[]>;
  /** block weight with unit/basis */
  weights: Record<BlockId, Quantity>;
  /** per-instruction live-after sets, keyed by instruction id (program order) */
  liveAfter: Record<string, VReg[]>;
  /** per-instruction live-before sets */
  liveBefore: Record<string, VReg[]>;
}

export function blockWeightOf(p: Program, b: Block, weightBase: number): Quantity {
  return blockWeight(b.loopDepth, weightBase);
}

export function computeLiveness(p: Program, weightBase: number, run: number): LivenessResult {
  const blocks = [...p.blocks].sort((a, b) => (a.id < b.id ? -1 : 1));
  const preds = computePreds(p.blocks);

  const phisByBlock = new Map<BlockId, Phi[]>();
  for (const phi of p.phis) {
    const arr = phisByBlock.get(phi.block) ?? [];
    arr.push(phi);
    phisByBlock.set(phi.block, arr);
  }

  const instrByBlock = new Map<BlockId, Program["instructions"]>();
  for (const ins of p.instructions) {
    const arr = instrByBlock.get(ins.block) ?? [];
    arr.push(ins);
    instrByBlock.set(ins.block, arr);
  }
  for (const arr of instrByBlock.values()) arr.sort((a, b) => a.index - b.index);

  // edge uses: v is used on edge P->S if a phi in S takes v from P
  const edgeUses: Record<string, VReg[]> = {};
  const edgeUseSets = new Map<string, Set<VReg>>();
  for (const b of blocks) {
    for (const s of b.succs) {
      const key = `${b.id}->${s}`;
      const set = new Set<VReg>();
      for (const phi of phisByBlock.get(s) ?? []) {
        for (const inc of phi.incoming) if (inc.from === b.id) set.add(inc.v);
      }
      edgeUseSets.set(key, set);
      edgeUses[key] = [...set].sort();
    }
  }

  const defSets = new Map<BlockId, Set<VReg>>();
  const useSets = new Map<BlockId, Set<VReg>>();
  for (const b of blocks) {
    const def = new Set<VReg>();
    const use = new Set<VReg>();
    for (const ins of instrByBlock.get(b.id) ?? []) {
      for (const u of ins.uses) if (!def.has(u.v)) use.add(u.v);
      for (const d of ins.defs) def.add(d.v);
    }
    // phi destinations are defined at the top of the block
    for (const phi of phisByBlock.get(b.id) ?? []) def.add(phi.dst.v);
    defSets.set(b.id, def);
    useSets.set(b.id, use);
  }

  const liveIn = new Map<BlockId, Set<VReg>>();
  const liveOut = new Map<BlockId, Set<VReg>>();
  for (const b of blocks) {
    liveIn.set(b.id, new Set());
    liveOut.set(b.id, new Set());
  }

  // iterate to fixpoint, reverse post-order-ish deterministic sweep
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (const b of [...blocks].reverse()) {
      const out = new Set<VReg>();
      for (const s of b.succs) {
        const phiDefs = new Set((phisByBlock.get(s) ?? []).map((x) => x.dst.v));
        for (const v of liveIn.get(s)!) if (!phiDefs.has(v)) out.add(v);
        for (const v of edgeUseSets.get(`${b.id}->${s}`)!) out.add(v);
      }
      const inn = new Set(useSets.get(b.id)!);
      for (const v of out) if (!defSets.get(b.id)!.has(v)) inn.add(v);
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

  // per-instruction live sets, walking each block backwards from liveOut
  const liveAfter: Record<string, VReg[]> = {};
  const liveBefore: Record<string, VReg[]> = {};
  for (const b of blocks) {
    const instrs = instrByBlock.get(b.id) ?? [];
    let cur = new Set(liveOut.get(b.id)!);
    for (let i = instrs.length - 1; i >= 0; i--) {
      const ins = instrs[i];
      liveAfter[ins.id] = [...cur].sort();
      const before = new Set(cur);
      for (const d of ins.defs) before.delete(d.v);
      for (const u of ins.uses) before.add(u.v);
      liveBefore[ins.id] = [...before].sort();
      cur = before;
    }
  }

  const weights: Record<BlockId, Quantity> = {};
  for (const b of blocks) weights[b.id] = blockWeightOf(p, b, weightBase);

  const rec = (m: Map<BlockId, Set<VReg>>): Record<BlockId, VReg[]> =>
    Object.fromEntries([...m.entries()].sort().map(([k, v]) => [k, [...v].sort()]));

  return {
    run,
    liveIn: rec(liveIn),
    liveOut: rec(liveOut),
    edgeUses,
    weights,
    liveAfter,
    liveBefore,
  };
}

function setEq(a: Set<VReg>, b: Set<VReg>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
