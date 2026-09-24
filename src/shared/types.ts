/**
 * 领域类型：编译器 / 寄存器分配 / 活跃性审阅
 *
 * 分层原则：
 *  - *Material（不可变材料）：原指令顺序、def/use、CFG、寄存器类、预着色、
 *    clobber、move。导入后内容寻址，永不被后续计算覆盖。
 *  - *Decision（可修改决定）：参数版本、人工选择、coalescing/spill 选择。
 *  - Derived*（派生层）：liveness / interference / coloring / spill 重写，
 *    每条记录都带 inputs 摘要、参数版本与父级依赖。
 */

export type Unit = 'gpr' | 'fpr';

export interface CoordinateBasis {
  /** 坐标基准：指令索引按原文本行序（0 起）；CFG 节点为 label 名 */
  instructionIndexBasis: 'source-line-order:0-based';
  registerUnitDomain: 'physical-or-virtual-with-class-unit';
}

export interface RegClass {
  id: string; // 稳定身份：id 即原始 token，例如 gpr32 / fpr64
  unit: Unit;
  /** 可用物理寄存器（原始名，导入不改名） */
  members: string[];
}

export interface Operand {
  /** 原始 token 文本，导入时保留原始表示 */
  raw: string;
  kind: 'virtual' | 'physical';
  name: string;
  /** 源文本上的寄存器类标注（如 :fpr64），无标注则为 null（不是默认值） */
  annotatedClass: string | null;
  /** 解析后按规则解析出的类；无法判定时为 null 并挂诊断 */
  resolvedClass: string | null;
}

export type InstructionKind =
  | 'phi'
  | 'label'
  | 'branch'
  | 'jump'
  | 'call'
  | 'return'
  | 'move'
  | 'generic';

export interface Instruction {
  /** 稳定身份：内容寻址哈希，导出再导入保持 */
  id: string;
  /** 原指令顺序（源文本行序，0 起）——不可变 */
  order: number;
  sourceLine: number; // 1 起的源行号（坐标）
  block: string | null;
  rawText: string; // 原始表示
  kind: InstructionKind;
  opcode: string;
  defs: Operand[];
  uses: Operand[];
  /** phi 专用：[blockLabel, operand] 列表，按前驱边计活跃 */
  phiEntries: { predBlock: string; operand: Operand }[];
  /** move 专用：def/use 若为跨类 move，coalescing 不得合并 */
  moveFrom: Operand | null;
  moveTo: Operand | null;
  /** call：clobber 的物理寄存器（调用约定，原始名） */
  clobbers: string[];
  /** branch/jump 目标 label（CFG 边），按原顺序 */
  successors: string[];
}

export interface Block {
  label: string;
  /** 指令 order 区间 [start,end) */
  start: number;
  end: number;
  successors: string[];
  predecessors: string[];
}

export interface Precolor {
  /** 虚拟寄存器名 -> 指定物理寄存器（原始表示） */
  virtual: string;
  physical: string;
  atInstruction: number | null;
}

/** 循环权重锚点：循环 header 及其嵌套深度，权重 = loopWeight^depth */
export interface LoopAnchor {
  headerBlock: string;
  latchBlock: string;
  parentHeader: string | null;
  depth: number;
  blocks: string[];
}

/** 不可变材料 */
export interface FunctionMaterial {
  name: string;
  rawText: string;
  registerClasses: RegClass[];
  instructions: Instruction[];
  blocks: Block[];
  precolors: Precolor[];
  loopAnchors: LoopAnchor[];
  coordinateBasis: CoordinateBasis;
}

export interface ProjectMaterial {
  format: 'regalloc-case/v1';
  functions: FunctionMaterial[];
  /** 原始字节级表示片段（按源行保留，派生层才规范化） */
  sourceSegments: { path: string; text: string }[];
}

export interface Positioned {
  path: string;
  line: number;
  column: number;
  endColumn?: number;
}

export interface Diagnostic {
  code:
    | 'INCOMPLETE_INPUT'
    | 'MALFORMED_FORMAT'
    | 'UNCONVERTIBLE_VALUE'
    | 'SEMANTIC_NO_SOLUTION'
    | 'RESOURCE_EXHAUSTED'
    | 'CONFLICTING_DECISION';
  message: string;
  position: Positioned | null;
  /** 无法转换的值留在原位置 */
  offendingRaw?: string;
}

/** 参数版本（可修改决定层） */
export interface AllocatorParams {
  paramVersion: string; // 内容哈希
  parentParamVersion: string | null;
  loopWeight: number; // 例如 10
  highDegreeThreshold: number; // 度 >= 该值为高（高度节点）
  budget: number; // 资源预算：最大 spill 轮数
  notes: string;
}

export type DecisionType =
  | 'coalesce'
  | 'freeze'
  | 'spill-pick'
  | 'color-pick'
  | 'accept'
  | 'reject'
  | 'param-revision'
  | 'rewrite';

export interface DecisionRecord {
  id: string;
  type: DecisionType;
  atEvent: string; // 事件 id
  /** 人工/自动 */
  origin: 'auto' | 'human';
  /** 无法唯一决定时的全部合法候选 */
  candidates: string[];
  chosen: string | null;
  rationale: string;
  /** 每次决策依据：输入摘要 + 父级依赖 */
  basis: { inputDigest: string; parentEventIds: string[]; paramVersion: string };
  supersedes: string | null;
}

/** 派生：phi 边活跃性（按前驱边计入） */
export interface PhiEdgeLiveness {
  edgeId: string; // pred->succ 稳定身份
  predBlock: string;
  succBlock: string;
  /** 该边上 live 的 phi 操作数（原始名） */
  livePhiOperands: string[];
}

export interface LivenessResult {
  id: string;
  digest: string; // 输入摘要
  paramVersion: string;
  parentId: string | null;
  functionName: string;
  /** 每条指令的 live-in / live-out（虚拟/物理名） */
  points: {
    instructionId: string;
    order: number;
    liveIn: string[];
    liveOut: string[];
  }[];
  blockLiveIn: Record<string, string[]>;
  blockLiveOut: Record<string, string[]>;
  phiEdges: PhiEdgeLiveness[];
  /** 循环深度（坐标基准）与生效区间 */
  loopDepthByBlock: Record<string, number>;
}

export interface InterferenceEdge {
  id: string;
  a: string;
  b: string;
  /** 干涉发生的指令点（order），坐标可回放 */
  atOrders: number[];
  reason: 'live-out-at-def' | 'precolor-clobber' | 'call-clobber' | 'phi-edge' | 'same-def';
}

export interface AffinityEdge {
  id: string;
  moveInstructionId: string;
  a: string;
  b: string;
  sameClass: boolean;
  /** coalescing 失败时 move 不得删除 */
  coalesced: boolean;
  rejectedReason: string | null;
}

export interface InterferenceResult {
  id: string;
  digest: string;
  paramVersion: string;
  parentId: string | null;
  functionName: string;
  nodes: string[];
  nodeClass: Record<string, string | null>;
  edges: InterferenceEdge[];
  affinities: AffinityEdge[];
  /** 度（含高/低标记依据） */
  degree: Record<string, number>;
}

export type StackAction = 'simplify-low' | 'freeze-high' | 'potential-spill';

export interface StackEntry {
  node: string;
  order: number; // 简化栈顺序（稳定）
  action: StackAction;
  degreeAtRemoval: number;
  reason: string;
}

export interface SpillCost {
  node: string;
  loopWeightedCost: number; // 带单位：加权 use/def 次数
  rawUseDefCount: number;
  /** 生效区间（指令 order 列表） */
  useDefOrders: number[];
  loopDepthMax: number;
}

export interface SimplifyResult {
  id: string;
  digest: string;
  paramVersion: string;
  parentId: string | null;
  functionName: string;
  kByClass: Record<string, number>;
  stack: StackEntry[];
  potentialSpills: string[];
  spillCosts: SpillCost[];
}

export interface ColorChoice {
  node: string;
  color: string | null; // null = 本轮无可用颜色
  physicalUnit: string;
  legalCandidates: string[]; // 无法唯一决定时的全部合法候选
  forbiddenBy: { physical: string; reason: string }[];
  reason: string;
}

export interface SelectResult {
  id: string;
  digest: string;
  paramVersion: string;
  parentId: string | null;
  functionName: string;
  choices: ColorChoice[];
  /** SEMANTIC_NO_SOLUTION / RESOURCE_EXHAUSTED 的区分依据 */
  outcome: 'colored' | 'needs-spill' | 'no-solution';
}

export interface RewriteDiff {
  beforeInstructionId: string | null;
  afterInstructionId: string | null;
  order: number;
  change: 'insert-store' | 'insert-reload' | 'replace-operand' | 'unchanged';
  beforeText: string | null;
  afterText: string | null;
}

export interface SpillRewriteResult {
  id: string;
  digest: string;
  paramVersion: string;
  parentId: string | null;
  functionName: string;
  spilledNode: string;
  round: number;
  /** 重写后产生的新不可变材料（派生材料层），图必须重新计算 */
  rewrittenMaterialId: string;
  diffs: RewriteDiff[];
  recomputedLivenessId: string;
  recomputedInterferenceId: string;
}

/** 机器可读取事件 */
export interface EventRecord {
  id: string;
  seq: number;
  kind:
    | 'material-imported'
    | 'diagnostic'
    | 'params-revised'
    | 'liveness-computed'
    | 'interference-computed'
    | 'coalesce-decision'
    | 'simplify-computed'
    | 'select-computed'
    | 'spill-picked'
    | 'rewrite-computed'
    | 'human-decision'
    | 'accepted'
    | 'rejected';
  branchId: string;
  at: string; // ISO 时间基准
  title: string;
  detail: Record<string, unknown>;
  resultRef: string | null; // 派生结果 id
  inputDigest: string | null;
  paramVersion: string | null;
  parentEventIds: string[];
  decisionId: string | null;
  status: 'adopted' | 'not-adopted' | 'diagnostic';
}

export interface Branch {
  id: string;
  parentBranchId: string | null;
  label: string;
  headEventId: string;
  createdAt: string;
}

export interface RunPackage {
  material: ProjectMaterial;
  materialId: string;
  params: AllocatorParams;
  branches: Branch[];
  events: EventRecord[];
  decisions: DecisionRecord[];
  results: Record<string, unknown>;
}

export interface ExportBundle {
  format: 'regalloc-review-export/v1';
  exportedAt: string;
  materialId: string;
  material: ProjectMaterial;
  params: AllocatorParams[];
  branches: Branch[];
  events: EventRecord[];
  decisions: DecisionRecord[];
  results: Record<string, unknown>;
  cases: CasePack;
}

export interface CaseStep {
  kind: 'param-revision' | 'source-change' | 'conflicting-decision';
  title: string;
  description: string;
  branchLabel: string;
  payload: Record<string, unknown>;
  expectedEventKinds: string[];
  expectedDiagnostics: string[];
}

export interface CasePack {
  id: string;
  title: string;
  narrative: string;
  initialMaterialPath: string;
  steps: CaseStep[];
  assertions: string[];
}
