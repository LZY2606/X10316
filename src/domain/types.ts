export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  col?: number;
}

/** 领域量：保留原始表示（raw），派生层才做规范化；无法转换时附诊断。 */
export interface Quantity {
  raw: string;
  value: number | null;
  unit: string | null;
  basis?: string;
  diagnostic?: string;
}

export interface RegClass {
  name: string;
  regs: string[];
}

export interface Precolor {
  vreg: string;
  phys: string;
  line: number;
}

export interface Operand {
  name: string;
  cls: string;
}

export interface PhiUse {
  pred: string;
  name: string;
}

export interface Instruction {
  id: string;
  block: string;
  order: number;
  op: string;
  defs: Operand[];
  uses: Operand[];
  phiUses: PhiUse[];
  move: { from: string; to: string; fromClass: string; toClass: string } | null;
  call: boolean;
  clobbers: string[];
  line: number;
  raw: string;
}

export interface Block {
  name: string;
  order: number;
  weight: Quantity;
  succs: string[];
}

/** 不可变材料层：原指令顺序、def/use、CFG、寄存器类、预着色、clobber、move 全部保留。 */
export interface Materials {
  id: string;
  source: string;
  digest: string;
  classes: RegClass[];
  precolors: Precolor[];
  blocks: Block[];
  edges: { from: string; to: string }[];
  instructions: Instruction[];
  moves: { instrId: string; from: string; to: string; fromClass: string; toClass: string }[];
  diagnostics: Diagnostic[];
}

export type ParseOutcome =
  | { ok: true; materials: Materials }
  | { ok: false; diagnostics: Diagnostic[] };

export type FailureKind = 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';

export interface DomainEvent {
  id: string;
  iteration: number;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface InstrLiveness {
  id: string;
  liveBefore: string[];
  liveAfter: string[];
}

export interface BlockLiveness {
  block: string;
  liveIn: string[];
  liveOut: string[];
  instrs: InstrLiveness[];
}

export interface GraphView {
  className: string;
  k: number;
  nodes: { id: string; kind: 'vreg' | 'phys'; degree: number }[];
  edges: [string, string][];
}

export interface SpillCandidate {
  node: string;
  cls: string;
  degree: number;
  cost: Quantity;
}

export interface IterationTrace {
  index: number;
  liveSets: BlockLiveness[];
  graphs: GraphView[];
  simplifyStack: string[];
  spill: { candidates: SpillCandidate[]; victim: string | null; tied: string[] } | null;
}

export interface RewriteEntry {
  iteration: number;
  kind: 'coalesce' | 'spill_rewrite';
  summary: string;
  before: string[];
  after: string[];
}

export interface MoveStatus {
  instrId: string;
  from: string;
  to: string;
  status: 'pending' | 'coalesced' | 'kept' | 'cross_class_kept';
  reason?: string;
}

export interface PipelineParams {
  loopExponent: number;
  maxIterations: number;
  simplifyBudget: number;
  storeCost: string;
  loadCost: string;
}

export interface PipelineResult {
  status: 'ok' | FailureKind;
  diagnostics: Diagnostic[];
  events: DomainEvent[];
  iterations: IterationTrace[];
  coloring: { vreg: string; color: string; cls: string }[];
  moves: MoveStatus[];
  rewriteDiff: RewriteEntry[];
  inputDigest: string;
  paramFingerprint: string;
  failure?: string;
}
