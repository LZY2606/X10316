/**
 * Immutable IR materials layer.
 * Raw representations are preserved exactly as imported; normalization
 * happens only in derived computations. Every domain quantity carries
 * a unit or coordinate basis (see units.ts).
 */

export type RegClassId = string;
export type PhysReg = string;
export type VReg = string;
export type BlockId = string;

export interface RegClass {
  id: RegClassId;
  /** physical registers, allocation order is the listed order */
  regs: PhysReg[];
}

export interface VRegRef {
  v: VReg;
  class: RegClassId;
}

export interface Instruction {
  id: string;
  block: BlockId;
  /** original order within the block — immutable once imported */
  index: number;
  op: string;
  defs: VRegRef[];
  uses: VRegRef[];
  /** physical registers clobbered by this instruction (e.g. calls) */
  clobbers: PhysReg[];
  isMove: boolean;
}

export interface Phi {
  id: string;
  block: BlockId;
  dst: VRegRef;
  /** use is attributed to the predecessor EDGE, not the phi block */
  incoming: { v: VReg; from: BlockId }[];
}

export interface Block {
  id: BlockId;
  succs: BlockId[];
  /** loop nesting depth; coordinate basis for block weight = weightBase^loopDepth */
  loopDepth: number;
}

export interface Precolor {
  v: VReg;
  phys: PhysReg;
}

export interface Program {
  id: string;
  classes: RegClass[];
  blocks: Block[];
  phis: Phi[];
  instructions: Instruction[];
  precolors: Precolor[];
  callingConvention: { callerSaved: PhysReg[] };
}

/** Positioned diagnostic — never silently default incomplete input. */
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  pos: { block?: BlockId; index?: number; instrId?: string; field?: string };
  message: string;
}

export interface Params {
  version: number;
  /** base of block weight: weight = weightBase^loopDepth, unit "ref-weight" */
  weightBase: number;
  /** max spill/rewrite iterations before outcome "budget-exhausted" */
  maxIterations: number;
  /** max number of spill rewrites before outcome "budget-exhausted" */
  maxSpills: number;
}

export const DEFAULT_PARAMS: Params = {
  version: 1,
  weightBase: 10,
  maxIterations: 16,
  maxSpills: 64,
};

export function validateProgram(p: Program): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const classIds = new Map(p.classes.map((c) => [c.id, c]));
  const blockIds = new Set(p.blocks.map((b) => b.id));
  const physToClass = new Map<PhysReg, RegClassId>();
  for (const c of p.classes) for (const r of c.regs) physToClass.set(r, c.id);

  const checkRef = (
    ref: VRegRef,
    pos: Diagnostic["pos"],
  ) => {
    if (!classIds.has(ref.class)) {
      diags.push({
        code: "unknown-class",
        severity: "error",
        pos,
        message: `register class '${ref.class}' is not declared`,
      });
    }
  };

  for (const b of p.blocks) {
    for (const s of b.succs) {
      if (!blockIds.has(s)) {
        diags.push({
          code: "unknown-block",
          severity: "error",
          pos: { block: b.id, field: "succs" },
          message: `block '${b.id}' has successor '${s}' which is not declared`,
        });
      }
    }
    if (b.loopDepth < 0 || !Number.isInteger(b.loopDepth)) {
      diags.push({
        code: "bad-loop-depth",
        severity: "error",
        pos: { block: b.id, field: "loopDepth" },
        message: `block '${b.id}' loopDepth must be a non-negative integer`,
      });
    }
  }

  const preds = computePreds(p.blocks);
  for (const phi of p.phis) {
    checkRef(phi.dst, { block: phi.block, field: "phi.dst" });
    const seen = new Set<BlockId>();
    for (const inc of phi.incoming) {
      if (!blockIds.has(inc.from)) {
        diags.push({
          code: "unknown-block",
          severity: "error",
          pos: { block: phi.block, field: "phi.incoming.from" },
          message: `phi '${phi.id}' incoming from unknown block '${inc.from}'`,
        });
      } else if (!preds.get(phi.block)!.has(inc.from)) {
        diags.push({
          code: "phi-non-pred",
          severity: "error",
          pos: { block: phi.block, field: "phi.incoming.from" },
          message: `phi '${phi.id}' incoming block '${inc.from}' is not a predecessor of '${phi.block}'`,
        });
      }
      if (seen.has(inc.from)) {
        diags.push({
          code: "phi-dup-edge",
          severity: "error",
          pos: { block: phi.block, field: "phi.incoming.from" },
          message: `phi '${phi.id}' has duplicate incoming edge from '${inc.from}'`,
        });
      }
      seen.add(inc.from);
    }
  }

  const seenInstr = new Set<string>();
  for (const ins of p.instructions) {
    const pos = { block: ins.block, index: ins.index, instrId: ins.id };
    if (seenInstr.has(ins.id)) {
      diags.push({
        code: "dup-instr",
        severity: "error",
        pos,
        message: `duplicate instruction id '${ins.id}'`,
      });
    }
    seenInstr.add(ins.id);
    if (!blockIds.has(ins.block)) {
      diags.push({
        code: "unknown-block",
        severity: "error",
        pos,
        message: `instruction '${ins.id}' is in unknown block '${ins.block}'`,
      });
    }
    for (const d of ins.defs) checkRef(d, { ...pos, field: "defs" });
    for (const u of ins.uses) checkRef(u, { ...pos, field: "uses" });
    for (const cl of ins.clobbers) {
      if (!physToClass.has(cl)) {
        diags.push({
          code: "unknown-phys",
          severity: "error",
          pos: { ...pos, field: "clobbers" },
          message: `instruction '${ins.id}' clobbers undeclared physical register '${cl}'`,
        });
      }
    }
  }

  const vregClass = new Map<VReg, RegClassId>();
  for (const ins of p.instructions) {
    for (const d of ins.defs) if (!vregClass.has(d.v)) vregClass.set(d.v, d.class);
    for (const u of ins.uses) if (!vregClass.has(u.v)) vregClass.set(u.v, u.class);
  }
  for (const phi of p.phis) if (!vregClass.has(phi.dst.v)) vregClass.set(phi.dst.v, phi.dst.class);

  for (const pc of p.precolors) {
    const cls = vregClass.get(pc.v);
    if (!cls) {
      diags.push({
        code: "precolor-unknown-vreg",
        severity: "error",
        pos: { field: "precolors" },
        message: `precolored vreg '${pc.v}' is never defined`,
      });
      continue;
    }
    const physCls = physToClass.get(pc.phys);
    if (!physCls) {
      diags.push({
        code: "unknown-phys",
        severity: "error",
        pos: { field: "precolors" },
        message: `precolor physical register '${pc.phys}' is not in any register class`,
      });
    } else if (physCls !== cls) {
      diags.push({
        code: "precolor-class-mismatch",
        severity: "error",
        pos: { field: "precolors" },
        message: `vreg '${pc.v}' of class '${cls}' cannot be precolored to '${pc.phys}' of class '${physCls}'`,
      });
    }
  }
  return diags;
}

export function computePreds(blocks: Block[]): Map<BlockId, Set<BlockId>> {
  const preds = new Map<BlockId, Set<BlockId>>();
  for (const b of blocks) preds.set(b.id, new Set());
  for (const b of blocks) for (const s of b.succs) preds.get(s)?.add(b.id);
  return preds;
}

/** deterministic ordering: equivalent inputs always produce the same order */
export function sortProgram(p: Program): Program {
  const byStr = <T>(f: (x: T) => string) => (a: T, b: T) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);
  return {
    ...p,
    classes: [...p.classes].sort(byStr((c) => c.id)),
    blocks: [...p.blocks].sort(byStr((b) => b.id)),
    phis: [...p.phis].sort(byStr((x) => x.id)),
    instructions: [...p.instructions].sort(
      (a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : a.index - b.index),
    ),
    precolors: [...p.precolors].sort(byStr((x) => x.v)),
  };
}
