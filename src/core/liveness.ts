import type { ProgramMaterial } from "./types.js";
import { analyzeCfg, type CfgInfo } from "./cfg.js";
import { sortedUnique } from "./identity.js";

export interface LivenessResult {
  cfg: CfgInfo;
  /** node text -> register class (virtual operands and physical operands). */
  nodeClass: Map<string, string>;
  /** virtual operand -> fixed physical (precolor), physical name -> itself. */
  fixedColor: Map<string, string>;
  liveIn: Map<string, Set<string>>; // block label
  liveOut: Map<string, Set<string>>;
  /** instruction id -> set live just before / after the instruction. */
  liveBefore: Map<string, Set<string>>;
  liveAfter: Map<string, Set<string>>;
  /** phi edge key "pred:phi-block" -> live operand (the edge use). */
  phiEdgeLive: Map<string, Set<string>>;
  /** call instruction id -> clobbered physical names. */
  callClobbers: Map<string, Set<string>>;
}

export function analyzeLiveness(program: ProgramMaterial): LivenessResult {
  const cfg = analyzeCfg(program);
  const nodeClass = new Map<string, string>();
  const fixedColor = new Map<string, string>();
  for (const ins of program.instructions) {
    for (const op of [...ins.defs, ...ins.uses]) {
      if (op.registerClass) nodeClass.set(op.text, op.registerClass);
      if (op.text.startsWith("$")) fixedColor.set(op.text, op.text.slice(1));
    }
  }
  for (const pc of program.precolors) {
    // precolor operand is referenced as its original virtual name
    for (const ins of program.instructions) {
      for (const op of [...ins.defs, ...ins.uses]) {
        if (!op.text.startsWith("$") && op.text.split(":")[0] === pc.operand) {
          fixedColor.set(op.text, pc.physical);
        }
      }
    }
  }

  const blockOf = new Map<number, string>();
  for (const b of program.blocks) {
    for (let i = b.start; i <= b.end; i++) blockOf.set(i, b.label);
  }

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  const liveBefore = new Map<string, Set<string>>();
  const liveAfter = new Map<string, Set<string>>();
  const phiEdgeLive = new Map<string, Set<string>>();
  const callClobbers = new Map<string, Set<string>>();
  for (const b of program.blocks) {
    liveIn.set(b.label, new Set());
    liveOut.set(b.label, new Set());
  }
  const conventionById = new Map(program.conventions.map((c) => [c.id, c]));

  // phi uses grouped by their block
  const phiUsesByBlock = new Map<string, Array<{ operand: string; edge: string }>>();
  for (const ins of program.instructions) {
    if (!ins.isPhi) continue;
    const label = blockOf.get(ins.index)!;
    const arr = phiUsesByBlock.get(label) ?? [];
    for (const u of ins.uses) {
      if (u.edge) arr.push({ operand: u.text, edge: u.edge });
      // edge live record
      const key = `${u.edge}->${label}`;
      const set = phiEdgeLive.get(key) ?? new Set<string>();
      set.add(u.text);
      phiEdgeLive.set(key, set);
    }
    phiUsesByBlock.set(label, arr);
  }

  const instrAt = new Map(program.instructions.map((i) => [i.index, i]));
  const useOf = (ins: (typeof program.instructions)[number]) =>
    ins.isPhi ? [] : ins.uses.map((u) => u.text);
  const defOf = (ins: (typeof program.instructions)[number]) => ins.defs.map((d) => d.text);

  let changed = true;
  while (changed) {
    changed = false;
    for (let bi = program.blocks.length - 1; bi >= 0; bi--) {
      const block = program.blocks[bi];
      let live = new Set<string>();
      for (const s of cfg.succ.get(block.label) ?? []) {
        for (const v of liveIn.get(s) ?? []) live.add(v);
        // phi edge use: value coming from THIS predecessor is live on the edge
        for (const pu of phiUsesByBlock.get(s) ?? []) {
          if (pu.edge === block.label) live.add(pu.operand);
        }
      }
      const outSnapshot = new Set(live);
      for (let idx = block.end; idx >= block.start; idx--) {
        const ins = instrAt.get(idx)!;
        liveAfter.set(ins.id, new Set(live));
        if (ins.op === "call" && ins.callConvention) {
          const conv = conventionById.get(ins.callConvention);
          const clob = new Set<string>((conv?.clobbers ?? []).map((p) => `$${p}`));
          callClobbers.set(ins.id, clob);
          // clobbered physicals are dead across the call: remove them from
          // the tracked live set (they interfere, handled in graph build).
          for (const c of clob) live.delete(c);
        }
        for (const d of defOf(ins)) live.delete(d);
        for (const u of useOf(ins)) live.add(u);
        liveBefore.set(ins.id, new Set(live));
      }
      const oldIn = liveIn.get(block.label)!;
      const oldOut = liveOut.get(block.label)!;
      if (!setEq(oldIn, live) || !setEq(oldOut, outSnapshot)) {
        liveIn.set(block.label, live);
        liveOut.set(block.label, outSnapshot);
        changed = true;
      }
    }
  }

  return { cfg, nodeClass, fixedColor, liveIn, liveOut, liveBefore, liveAfter, phiEdgeLive, callClobbers };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function sortedSet(s: Set<string>): string[] {
  return sortedUnique(s);
}
