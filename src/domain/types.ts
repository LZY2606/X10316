export interface Diagnostic {
  position: string;
  severity: 'error' | 'warning';
  message: string;
}

export type FailureKind = 'format_corrupt' | 'budget_exhausted' | 'unsatisfiable';
export type Status = 'ok' | FailureKind;

export interface Quantity {
  raw: string;
  value: number | null;
  unit: string | null;
  basis: string | null;
  diagnostic?: Diagnostic;
}

export interface VRegRef {
  v: string;
  class: string;
}

export interface PhiUse {
  v: string;
  pred: string;
}

export interface Instr {
  id: string;
  op: string;
  coord: string; // coordinate basis: "<block>/<index>"
  defs: VRegRef[];
  uses: VRegRef[];
  phiUses: PhiUse[];
  precolor: Record<string, string>;
  clobbers: string[];
  move: boolean;
  crossClass: boolean;
  cost: Quantity | null;
  text: string;
}

export interface Block {
  id: string;
  loopDepth: number;
  instrs: Instr[];
  succs: string[];
}

export interface RegClass {
  id: string;
  regs: string[];
}

export interface FunctionMaterial {
  kind: 'function';
  name: string;
  regClasses: RegClass[];
  abi: { callerSaved: string[]; argRegs: string[] };
  blocks: Block[];
}

export interface ParamSet {
  version: string;
  loopWeightBase: number;
  loopWeightExponent: number;
  coalesceRule: 'briggs';
  budget: { maxInstrs: number; maxSimplifySteps: number; maxSpillRounds: number };
}

export interface LivenessResult {
  blocks: Record<
    string,
    {
      liveIn: string[];
      liveOut: string[];
      edgeOut: Record<string, string[]>; // succId -> vregs used by phis on this edge
    }
  >;
  instrLive: Record<string, { liveBefore: string[]; liveAfter: string[] }>;
}

export interface GraphNode {
  id: string;
  class: string;
  precolored: boolean;
  color: string | null;
  spillCost: Quantity;
  degree: number;
}

export interface InterferenceGraph {
  nodes: GraphNode[];
  edges: Array<[string, string]>;
  moveEdges: Array<{ a: string; b: string; instr: string; crossClass: boolean }>;
}

export interface CoalesceDecision {
  instr: string;
  a: string;
  b: string;
  rule: string;
  mergedDegree: number | null;
  k: number;
  result: 'coalesced' | 'kept';
  reason: string;
}

export interface CoalesceResult {
  alias: Record<string, string>; // vreg -> representative
  decisions: CoalesceDecision[];
  keptMoves: string[]; // instr ids whose move must be preserved
}

export interface SimplifyStep {
  node: string;
  action: 'push' | 'spill_candidate';
  reason: string;
  degree: number;
}

export interface ColorResult {
  assignments: Record<string, string>;
  spills: string[];
  simplifyStack: SimplifyStep[];
  conflicts: Diagnostic[];
}

export interface RewriteDiffEntry {
  at: string; // coordinate
  before: string[];
  after: string[];
}

export interface SpillRewrite {
  spilled: string[];
  slots: Record<string, string>;
  diff: RewriteDiffEntry[];
  function: FunctionMaterial;
}
