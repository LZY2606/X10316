// ---------- Immutable IR materials ----------
export interface RegClassDef { name: string; physRegs: string[] }

export interface Operand { vreg: string; class: string }

export interface PhiInstr {
  kind: 'phi';
  id: string;
  def: Operand;
  sources: { vreg: string; pred: string }[];
}
export interface RegularInstr {
  kind: 'instr';
  id: string;
  opcode: string;
  defs: Operand[];
  uses: Operand[];
  isMove?: boolean;
  clobbers?: string[]; // phys regs clobbered (e.g. call)
}
export type Instr = PhiInstr | RegularInstr;

export interface Block {
  id: string;
  loopDepth: number;
  instrs: Instr[];
  succs: string[];
}
export interface FunctionIR {
  name: string;
  regClasses: RegClassDef[];
  precolors: { vreg: string; phys: string }[];
  entry: string;
  blocks: Block[];
}

// ---------- Diagnostics ----------
export interface Diagnostic {
  code: string;
  message: string;
  pos: { block?: string; instr?: string; operand?: number };
}

// ---------- Parameters (versioned) ----------
export interface AllocParams {
  version: string;
  loopWeightBase: number;   // weight multiplier per loop depth
  maxSpillRounds: number;   // resource budget
  coalesceStrategy: 'briggs';
}

// ---------- Liveness ----------
export interface BlockLiveness {
  block: string;
  liveIn: string[];
  liveOut: string[];
  edgeLive: { edge: string; live: string[] }[]; // "pred->succ"
}

// ---------- Interference graph ----------
export interface InterferenceGraph {
  nodes: { id: string; class: string; precolored: string | null }[];
  adj: Record<string, string[]>; // node id -> sorted neighbour ids
}

// ---------- Trace events (machine readable) ----------
export type TraceEventType =
  | 'phi_edge_use'
  | 'precolor_conflict'
  | 'call_clobber'
  | 'cross_class_move'
  | 'high_degree_node'
  | 'coalesce_applied'
  | 'coalesce_failed_move_kept'
  | 'spill_cost'
  | 'spill_candidate'
  | 'spill_rewrite_recompute'
  | 'simplify_push'
  | 'color_choice'
  | 'color_conflict_candidates' // ambiguous: all legal candidates preserved
  | 'loop_weight_applied';

export interface TraceEvent {
  type: TraceEventType;
  detail: Record<string, unknown>;
}

// ---------- Run results: distinct failure kinds ----------
export type RunStatus = 'ok' | 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';

export interface SpillCostRow { vreg: string; class: string; weight: number; degree: number; cost: number }
export interface RewriteDiff {
  round: number;
  spilled: string[];
  before: string[]; // textual instrs
  after: string[];
}
export interface AllocationResult {
  status: 'ok';
  liveness: BlockLiveness[];
  graph: InterferenceGraph;
  simplifyStack: string[];
  colors: Record<string, string>;       // vreg -> phys reg
  uncolored: string[];                  // vregs with no unique color
  legalCandidates: Record<string, string[]>; // vreg -> all legal colors (for ambiguous nodes)
  spillCosts: SpillCostRow[];
  rewrites: RewriteDiff[];
  spillRounds: number;
  events: TraceEvent[];
}
export interface FailureResult {
  status: Exclude<RunStatus, 'ok'>;
  reason: string;
  diagnostics: Diagnostic[];
  events: TraceEvent[];
}
export type RunResult = AllocationResult | FailureResult;

// ---------- Persistence ----------
export interface StoredEvent {
  seq: number;
  id: string;          // evt:000001
  type: string;        // e.g. 'run', 'decision', 'material.import', 'param.revision'
  parents: string[];   // event ids this one depends on
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface StoredMaterial {
  id: string;          // mat:<hash12>
  kind: 'function' | 'params' | 'source-patch';
  hash: string;
  content: unknown;
  eventId: string;     // event that introduced it
  parentId: string | null;
  note: string;
}
export interface StoredDecision {
  id: string;          // dec:<hash12>
  eventId: string;
  target: string;      // event id or run id the decision refers to
  verdict: 'accept' | 'reject' | 'adjust';
  rationale: string;
  reviewer: string;
}
export interface StoredRun {
  id: string;          // run:<hash12>
  materialId: string;
  paramsVersion: string;
  inputHash: string;
  parentRunId: string | null;
  result: RunResult;
  eventId: string;
}
export interface Archive {
  format: 'regalloc-archive';
  version: 1;
  exportedAt: string;
  events: StoredEvent[];
  materials: StoredMaterial[];
  decisions: StoredDecision[];
  runs: StoredRun[];
}
