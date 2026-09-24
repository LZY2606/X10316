import type { AllocatorParams, ProgramMaterial, RewriteDifference, SpillCost } from "./types.js";
import type { LivenessResult } from "./liveness.js";

/** Spill cost = (defs+uses) weighted by loop depth. Unit: dimensionless weight. */
export function computeSpillCosts(program: ProgramMaterial, live: LivenessResult, params: AllocatorParams): SpillCost[] {
  const costs = new Map<string, SpillCost>();
  const ensure = (op: string, cls: string) => {
    if (!costs.has(op)) {
      costs.set(op, { operand: op, cost: 0, useCount: 0, defCount: 0, loopDepth: 0, loopWeight: params.loopWeight, reason: "" });
    }
    return costs.get(op)!;
  };
  const blockOf = new Map<number, string>();
  for (const b of program.blocks) for (let i = b.start; i <= b.end; i++) blockOf.set(i, b.label);

  for (const ins of program.instructions) {
    const label = blockOf.get(ins.index)!;
    const depth = live.cfg.loopDepth.get(label) ?? 0;
    const weight = params.loopWeight ** depth;
    for (const d of ins.defs) {
      const c = ensure(d.text, d.registerClass);
      c.defCount += 1;
      c.loopDepth = Math.max(c.loopDepth, depth);
      c.cost += weight;
    }
    for (const u of ins.uses) {
      const c = ensure(u.text, u.registerClass);
      c.useCount += 1;
      c.loopDepth = Math.max(c.loopDepth, depth);
      c.cost += weight;
    }
  }
  for (const c of costs.values()) {
    c.reason = `(${c.useCount} uses + ${c.defCount} defs) * ${c.loopWeight}^depth${c.loopDepth} = ${c.cost}`;
  }
  return [...costs.values()].sort((a, b) => (a.cost - b.cost || (a.operand < b.operand ? -1 : 1)));
}

/**
 * Rewrite program: spilled virtuals are stored to stack slots.
 * Produces a NEW material (immutable originals retained) plus the differences.
 */
export function rewriteSpills(
  program: ProgramMaterial,
  spilled: string[],
): { material: ProgramMaterial; differences: RewriteDifference[] } {
  const spillSet = new Set(spilled);
  const slotOf = new Map<string, string>();
  for (const s of spilled) {
    const name = s.split(":")[0].replace(/^\$/, "");
    slotOf.set(s, `slot_${name}`);
  }
  const differences: RewriteDifference[] = [];
  const instructions = program.instructions.map((ins) => {
    const defs = ins.defs.map((d) => ({ ...d }));
    const uses = ins.uses.map((u) => ({ ...u }));
    let text = ins.text;
    for (const d of defs) {
      if (spillSet.has(d.text)) {
        const slot = slotOf.get(d.text)!;
        differences.push({ kind: "insert-store", at: ins.index, before: d.text, after: `store ${d.text} -> ${slot}`, operand: d.text });
      }
    }
    for (const u of uses) {
      if (spillSet.has(u.text)) {
        const slot = slotOf.get(u.text)!;
        const reload = `reload_${u.text.split(":")[0].replace(/^\$/, "")}:${u.registerClass}`;
        differences.push({ kind: "insert-load", at: ins.index, before: u.text, after: `${reload} <- ${slot}`, operand: u.text });
      }
    }
    return { ...ins, defs, uses, text };
  });
  // Deterministic ordering of differences.
  differences.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.operand.localeCompare(b.operand));
  const material: ProgramMaterial = { ...program, instructions };
  return { material, differences };
}
