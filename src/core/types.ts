// Domain types for the register-allocation review system.
// Identities are STABLE: derived ids are content-addressed so equivalent
// inputs always produce the same ids and ordering.

export type RegisterClassId = string;

/** A physical register class with its member physical registers. */
export interface RegisterClass {
  id: RegisterClassId;
  /** Human name, e.g. "general purpose 32 bit". */
  name: string;
  /** Width unit, e.g. "bit:32". Quantities always carry their unit. */
  width: string;
  /** Ordered physical register names; order is the preference order. */
  members: string[];
}

/** A pre-coloured (physical) operand. */
export interface Precolor {
  operand: string;
  physical: string;
  registerClass: RegisterClassId;
}

/** Calling convention: call identifier -> clobbered physical registers. */
export interface CallConvention {
  /** e.g. "call:g" matched by CALL g instructions. */
  id: string;
  name: string;
  clobbers: string[];
}

export type OperandKind = "def" | "use";

export interface Operand {
  kind: OperandKind;
  /** Original textual token, preserved verbatim. */
  text: string;
  registerClass: RegisterClassId;
  /** Set for phi operands: predecessor block label of the edge use. */
  edge?: string;
}

export interface Instruction {
  /** 1-based index in original order (coordinate basis: instruction index). */
  index: number;
  /** Stable id: i<index>. */
  id: string;
  /** Original source line, never rewritten in the immutable layer. */
  text: string;
  /** Source line in the imported material (1-based). */
  sourceLine: number;
  op: string;
  defs: Operand[];
  uses: Operand[];
  /** Set when op === "call": convention id. */
  callConvention?: string;
  /** Phi flag (uses carry predecessor edges). */
  isPhi?: boolean;
  /** Parsed MOVE marker (eligible coalescing candidate). */
  isMove?: boolean;
}

export interface Block {
  id: string; // b<order>
  label: string; // original label token
  order: number;
  /** Instruction indices in the closed interval style [start,end]. */
  start: number;
  end: number;
  successors: string[]; // labels
}

/** Immutable imported material. Never mutated after creation. */
export interface ProgramMaterial {
  format: "regs-review-ir" | "ssa-ir";
  formatVersion: string;
  registerClasses: RegisterClass[];
  precolors: Precolor[];
  conventions: CallConvention[];
  instructions: Instruction[];
  blocks: Block[];
  /** Entry block label. */
  entry: string;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Position into the original material. */
  line?: number;
  column?: number;
  block?: string;
  instruction?: number;
  operand?: string;
  /** Failure category, always explicit (never faked success). */
  category?: "format" | "semantic" | "budget";
  /** Original unconvertible value kept in place. */
  rawValue?: string;
}

export type Ok<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

// ---- Derived analysis layers ------------------------------------------------

/** Edge-origin of a live value: which CFG edge/boundary it is live across. */
export interface LivePoint {
  /** Coordinate basis: "instr:<index>" or "edge:<from>-><to>" or block boundary. */
  at: string;
  operands: string[]; // sorted canonical operand names
}

export interface LiveRange {
  operand: string;
  registerClass: string;
  /** Instruction indices the operand is live at, with unit "instr-index". */
  points: number[];
  /** Edge liveness: phi uses live on edge pred->block. */
  edges: string[];
}

export interface InterferenceEdge {
  /** Stable identity "a|b" sorted. */
  id: string;
  a: string;
  b: string;
  reason: string; // human + machine reason code
  reasonCode: string;
  at: string; // coordinate where it arises
}

export interface MoveCandidate {
  id: string;
  moveIndex: number;
  src: string;
  dst: string;
  srcClass: string;
  dstClass: string;
  /** false => cross-class, never merged. */
  sameClass: boolean;
  coalesced: boolean;
  decision: "accepted" | "rejected" | "pending";
  reason?: string;
}

export interface SimplifyEntry {
  order: number;
  operand: string;
  /** "simplify" (low degree), "spill" (potential spill), "precolor-frozen". */
  action: "simplify" | "spill" | "freeze" | "precolor";
  degreeAtDecision: number;
  candidates: string[]; // all legal spill/color candidates retained
  reason: string;
}

export interface ColorChoice {
  operand: string;
  physical: string | null; // null => spilled
  registerClass: string;
  forbidden: string[]; // colors forbidden by neighbours
  legalCandidates: string[]; // all legal colors at decision time
  reason: string;
}

export interface SpillCost {
  operand: string;
  cost: number; // dimensionless weight (loopDepth weighted)
  useCount: number;
  defCount: number;
  loopDepth: number;
  loopWeight: number;
  reason: string;
}

export interface RewriteDifference {
  kind: "insert-store" | "insert-load" | "replace-use" | "replace-def";
  at: number;
  before: string;
  after: string;
  operand: string;
}

export interface AllocationResult {
  id: string;
  paramsVersion: string;
  parentId: string | null; // dependency
  inputSummary: InputSummary;
  coloring: Record<string, string | null>;
  spilled: string[];
  interferences: InterferenceEdge[];
  moves: MoveCandidate[];
  simplifyStack: SimplifyEntry[];
  colors: ColorChoice[];
  spillCosts: SpillCost[];
  liveRanges: LiveRange[];
  liveIn: Record<string, string[]>;
  liveOut: Record<string, string[]>;
  rewrite: RewriteDifference[];
  diagnostics: Diagnostic[];
  status: "colored" | "spilled" | "semantic-infeasible" | "budget-exhausted";
}

export interface InputSummary {
  materialHash: string;
  instructionCount: number;
  blockCount: number;
  operandCount: number;
}

export interface AllocatorParams {
  paramsVersion: string;
  registersPerClass: Record<string, number>; // available K (colors)
  /** Coalescing strategy. */
  coalescing: "briggs" | "off";
  /** Max spill iterations before budget exhaustion. */
  spillBudget: number;
  /** Loop weight multiplier per nesting depth. */
  loopWeight: number;
}

export const DEFAULT_PARAMS: AllocatorParams = {
  paramsVersion: "params-v1",
  registersPerClass: { gpr: 3, fpr: 2 },
  coalescing: "briggs",
  spillBudget: 2,
  loopWeight: 8,
};
