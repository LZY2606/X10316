// ---------------------------------------------------------------------------
// Domain model: immutable materials layer + mutable decisions layer.
// All domain quantities carry a unit/coordinate basis. The source layer keeps
// original textual representation; derived layers normalize.
// ---------------------------------------------------------------------------

export type CoordinateBasis =
  | { kind: "instructionIndex"; basis: "program-order, 0-based, per-function" }
  | { kind: "edgeLiveness"; basis: "CFG-edge (blockId, last-instruction-index)" }
  | { kind: "loopDepth"; basis: "natural-loop nesting depth, outer=1, derived from back edges" }
  | { kind: "cost"; basis: "weighted-spill-cost = sum(useCost*10^loopDepth + defCost*10^loopDepth)" }
  | { kind: "degree"; basis: "interference-edge count restricted to same register class" };

export interface TextPos {
  /** 1-based line number within the imported source text. */
  line: number;
  /** 1-based column offset within the line. */
  column: number;
  /** 0-based instruction index within its function, when applicable. */
  instructionIndex?: number;
  blockId?: string;
}

export type DiagnosticCode =
  | "FORMAT_CORRUPT"
  | "INPUT_INCOMPLETE"
  | "SEMANTIC_UNSAT"
  | "BUDGET_EXHAUSTED"
  | "UNCONVERTIBLE_VALUE";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  pos?: TextPos;
  /** Original token / fragment kept in place; never normalized away. */
  fragment?: string;
  /** Distinguishes the three mandated terminal outcomes. */
  fatal: boolean;
}

// --- Register classes / calling convention (immutable materials) ----------

export interface RegisterClass {
  id: string; // e.g. GPR32
  kind: string; // e.g. gpr / fpr
  widthBits: number;
  /** Ordered allocatable physical registers, original names preserved. */
  members: string[];
}

export interface CallingConvention {
  id: string;
  /** Physical registers caller-saved (clobbered) across a call. */
  callerSaved: string[];
  /** Argument physical registers, in order. */
  argumentRegs: string[];
  /** Return physical registers. */
  returnRegs: string[];
  calleeSaved: string[];
}

// --- Program IR -------------------------------------------------------------

export type OperandClass = "virt" | "phys";

export interface Operand {
  /** Original token exactly as written, e.g. "v3" or "$rax". */
  text: string;
  opClass: OperandClass;
  /** Virtual id (vN -> "N") or physical register name. */
  ref: string;
  /** Declared register class for a virtual operand; physical infers it. */
  regClassId: string;
  /** Original representation retained for unconvertible values. */
  rawClassToken?: string;
}

export type TerminatorKind = "br" | "cbr" | "ret" | "switch";

export interface Instr {
  /** Stable per-function id: i0, i1 ... in original program order. */
  id: string;
  index: number;
  blockId: string;
  opcode: string;
  defs: Operand[];
  uses: Operand[];
  /** Physical registers clobbered by this instruction (e.g. call). */
  clobbers: string[];
  /** phi uses: operand live-in only on the given predecessor edge. */
  phiUses: { operand: Operand; predBlockId: string }[];
  /** Move instruction marker (candidate for coalescing). */
  isMove: boolean;
  terminator?: {
    kind: TerminatorKind;
    successors: string[];
    /** cbr: branch condition operand carried in uses. */
  };
  /** Explicit precolor constraint def/use vN=$reg on this instruction. */
  precolors: { operand: Operand; phys: string }[];
  text: string;
  line: number;
}

export interface Block {
  id: string; // b0, b1 ...
  label: string;
  instrIds: string[];
  successorIds: string[];
  predecessorIds: string[];
  line: number;
}

export interface Func {
  id: string;
  name: string;
  blocks: Block[];
  instrs: Instr[];
  entryBlockId: string;
  /** Natural-loop nesting depth per instruction index (derived at import). */
  loopDepthByIndex: number[];
  /** Back edges detected at import (evidence for loop weights). */
  backEdges: { from: string; to: string }[];
}

/** Immutable material snapshot. Identities are stable across export/import. */
export interface SourceSnapshot {
  id: string; // snap-<sha256:12>
  format: "ra-ir" | "ra-bundle";
  formatVersion: string;
  importedAt: string;
  originalText: string;
  regClasses: RegisterClass[];
  conventions: CallingConvention[];
  funcs: Func[];
  /**
   * Values that could not be converted to the canonical model but are kept in
   * place (never dropped for plotting). Non-empty => import not accepted.
   */
  unconverted: { diag: Diagnostic }[];
  parserDiagnostics: Diagnostic[];
  coordinateBasis: CoordinateBasis[];
}

// --- Parameters (versioned, immutable once recorded) -----------------------

export interface AllocParams {
  version: number;
  parentVersion: number | null;
  /** Cost of one use occurrence, multiplied by 10^loopDepth. */
  useCost: number;
  defCost: number;
  /** Maximum spill rewrite rounds before BUDGET_EXHAUSTED. */
  spillBudget: number;
  /** Coalescing strategy. */
  coalescing: "iterated-conservative" | "briggs";
  /** Allow cross-class moves to be coalesced (must stay false). */
  allowCrossClassCoalesce: boolean;
  note: string;
}

export const DEFAULT_PARAMS_V1: AllocParams = {
  version: 1,
  parentVersion: null,
  useCost: 1,
  defCost: 1,
  spillBudget: 3,
  coalescing: "iterated-conservative",
  allowCrossClassCoalesce: false,
  note: "initial parameters"
};

// --- Decisions (mutable layer; every auto and human decision is evidence) --

export type DecisionKind =
  | "coalesce-accept"
  | "coalesce-reject"
  | "simplify"
  | "spill-select"
  | "color-accept"
  | "color-reject"
  | "rewrite-accept"
  | "rewrite-reject"
  | "parameter-change";

export interface Decision {
  id: string; // d<seq>
  seq: number;
  kind: DecisionKind;
  /** Stable subject identity, e.g. move id, node id, round number. */
  subject: string;
  rationale: string;
  /** All legal candidates retained when the outcome is not unique. */
  candidates: string[];
  chosen: string | null;
  origin: "auto" | "human";
  /** When a human decision conflicts with the auto recommendation. */
  conflictsWithAuto?: string;
  round: number;
}

// --- Events (append-only, machine readable) --------------------------------

export type EventType =
  | "import"
  | "params"
  | "analysis"
  | "coalesce"
  | "simplify"
  | "color"
  | "spill-select"
  | "rewrite"
  | "outcome"
  | "human-decision";

export interface Event {
  id: string; // e<seq>
  seq: number;
  branchId: string;
  parentEventId: string | null;
  type: EventType;
  funcId: string | null;
  /** Input summary (sha256 of canonical inputs) for replay verification. */
  inputSummary: string;
  paramsVersion: number;
  decisionIds: string[];
  computationId: string | null;
  message: string;
  at: string;
}

export interface Branch {
  id: string; // br-<hash8> or main
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  source: SourceSnapshot;
  params: AllocParams[];
  branches: Branch[];
  events: Event[];
  decisions: Decision[];
  computations: ComputationRecord[];
  outcome: Outcome | null;
}

// --- Derived computation records -------------------------------------------

export type OutcomeStatus = "colored" | "BUDGET_EXHAUSTED" | "SEMANTIC_UNSAT";

export interface Outcome {
  status: OutcomeStatus;
  funcId: string;
  rounds: number;
  finalColorById: Record<string, string | null>;
  diagnostics: Diagnostic[];
  at: string;
}

export interface ComputationRecord {
  id: string; // c<sha256:12>
  kind:
    | "liveness"
    | "interference"
    | "coalescing"
    | "simplify-stack"
    | "color-select"
    | "spill-cost"
    | "rewrite"
    | "pipeline";
  funcId: string;
  round: number;
  /** Canonical input summary: snapshot id + params version + parent comps. */
  inputSummary: string;
  paramsVersion: number;
  parentComputationIds: string[];
  payload: unknown;
  producedAt: string;
}

export interface LiveSetPoint {
  instrId: string;
  index: number;
  liveBefore: string[]; // virtual refs, canonical order
  liveAfter: string[];
}

export interface LivenessResult {
  funcId: string;
  round: number;
  points: LiveSetPoint[];
  /** phi operands accounted per predecessor edge (not block-wide). */
  edgeLive: { fromBlockId: string; toBlockId: string; live: string[] }[];
  liveRanges: { vreg: string; firstIndex: number; lastIndex: number; basis: string }[];
  loopDepthByIndex: number[];
}

export interface InterferenceResult {
  funcId: string;
  round: number;
  /** Sorted, deduped interference edges (same-class only). */
  edges: { a: string; b: string; reason: string }[];
  /** Move/affinity edges, including precolor affinity. */
  affinity: { a: string; b: string; moveId: string; sameClass: boolean }[];
  degreeById: Record<string, number>;
  nodes: { id: string; regClassId: string; precolor: string | null }[];
}

export interface CoalesceEntry {
  moveId: string;
  a: string;
  b: string;
  sameClass: boolean;
  accepted: boolean;
  reason: string;
  mergedNode: string | null;
}

export interface CoalescingResult {
  funcId: string;
  round: number;
  entries: CoalesceEntry[];
  /** Moves whose coalescing failed MUST remain in the program. */
  retainedMoveIds: string[];
  removedMoveIds: string[];
  unionParent: Record<string, string>;
}

export interface StackEntry {
  node: string;
  reason: "low-degree" | "potential-spill" | "precolored-frozen";
  degreeAtPush: number;
}

export interface SimplifyResult {
  funcId: string;
  round: number;
  stack: StackEntry[];
  spilledCandidates: { node: string; cost: number; basis: string }[];
}

export interface ColorChoice {
  node: string;
  chosenColor: string | null;
  legalCandidates: string[];
  forbiddenBy: string[];
  reason: string;
}

export interface ColorResult {
  funcId: string;
  round: number;
  choices: ColorChoice[];
  actualSpill: string | null;
}

export interface SpillCostResult {
  funcId: string;
  round: number;
  costs: {
    node: string;
    regClassId: string;
    degree: number;
    weightedCost: number;
    basis: string;
    occurrences: { instrId: string; kind: "def" | "use"; loopDepth: number; weight: number }[];
  }[];
  selected: string | null;
}

export interface RewriteResult {
  funcId: string;
  round: number;
  spilledVreg: string;
  /** Before/after diff keyed by stable identities. */
  beforeSnapshotId: string;
  afterSourceText: string;
  addedInstrs: { afterIndex: number; text: string; kind: "store" | "load" }[];
  removedInstrIds: string[];
  /** Graph must be recomputed after rewrite. */
  recomputedGraphCompId: string | null;
}

export interface PipelineRound {
  round: number;
  livenessId: string;
  interferenceId: string;
  coalescingId: string;
  simplifyId: string;
  colorId: string;
  spillCostId: string | null;
  rewriteId: string | null;
  spilled: string | null;
}

export interface PipelinePayload {
  rounds: PipelineRound[];
  status: OutcomeStatus;
}

// --- Export bundle ----------------------------------------------------------

export interface ExportBundle {
  format: "ra-bundle";
  formatVersion: "1.0";
  exportedAt: string;
  project: Project;
  /** Fenced integrity marker for half-write detection on import. */
  integrity: { sha256: string; length: number };
}
