// 共享领域类型：不可变材料 / 可修改决定 / 派生结果分层

export type Unit = string; // 单位或坐标基准，例如 "line:col" / "loop-depth" / "class:GPR"

export interface Pos {
  line: number;   // 1-based
  col: number;    // 1-based
  endLine?: number;
  endCol?: number;
}

// 三种必须区分的失败结果
export type FailureKind = "FORMAT_CORRUPT" | "SEMANTIC_UNSATISFIABLE" | "RESOURCE_EXHAUSTED";

export interface Diagnostic {
  code: string;          // 例如 E_PARSE_001
  kind: FailureKind;
  message: string;
  pos?: Pos;             // 带位置
  fragment?: string;     // 原始输入片段（保留原表示）
}

export class DomainError extends Error {
  diagnostics: Diagnostic[];
  kind: FailureKind;
  constructor(diag: Diagnostic | Diagnostic[]) {
    const list = Array.isArray(diag) ? diag : [diag];
    super(list.map((d) => d.message).join("; "));
    this.name = "DomainError";
    this.diagnostics = list;
    this.kind = list[0]!.kind;
  }
}

// ---- 不可变层：原指令材料 ----

export interface RegClass {
  id: string;                 // 稳定身份，如 GPR
  name: string;
  width: number;
  unit: string;               // 单位/坐标基准
  registers: string[];        // 物理寄存器名字，顺序即颜色顺序
}

export type OperandRole = "def" | "use";

export interface Operand {
  id: string;                 // op:<inst>:<index> 稳定身份
  role: OperandRole;
  reg: string;                // vreg/preg 原名，保留原始表示
  cls?: string;               // 操作数声明的类（跨类 move 时可为不同类）
  isPhiEdgeUse?: boolean;     // phi 使用，按前驱边计入
  predId?: string;            // phi 边来源块
}

export type ClobberKind = "call";

export interface Instruction {
  id: string;                 // i:<ord> 稳定身份
  ord: number;                // 原指令顺序
  blockId: string;
  text: string;               // 原始文本（原表示保留）
  op: string;                 // 操作码
  operands: Operand[];
  isPhi: boolean;
  isMove: boolean;
  callClobbers?: string[];    // 调用 clobber（preg 列表）
  pos?: Pos;
}

export interface Block {
  id: string;                 // b:<label>
  label: string;
  ord: number;                // 源中出现顺序
  instIds: string[];
  succIds: string[];
  predIds: string[];
  loopDepth: number;          // 坐标基准：循环层级
}

export interface PreColor {
  vreg: string;
  preg: string;
  cls: string;
  pos?: Pos;
}

export interface MoveRecord {
  id: string;                 // mv:<instId>
  instId: string;
  dst: string;
  src: string;
  dstCls: string;
  srcCls: string;
}

export interface IRProgram {
  sourceText: string;          // 原指令材料逐字保留
  classes: RegClass[];
  regClassOf: Record<string, string>; // vreg/preg -> class id
  precoloredVregs: PreColor[];
  blocks: Block[];
  instructions: Instruction[];
  moves: MoveRecord[];
  // 无法转换但保留在原位置的值（不丢弃）
  unconvertible: { pos?: Pos; fragment: string; reason: string }[];
}

// ---- 参数（规则版本） ----
export interface AllocParams {
  version: string;
  moveBias: number;          // move 内部使用代价折减
  loopWeight: number;        // 循环权重（每升一层深度乘它）
  spillRounds: number;       // 资源预算：允许的 spill 重写轮数
  tieBreak: "name" | "degree";
}

export const DEFAULT_PARAMS: AllocParams = {
  version: "rules-1.0.0",
  moveBias: 0.0,
  loopWeight: 10,
  spillRounds: 3,
  tieBreak: "name"
};

// ---- 派生层 ----

export interface LivenessData {
  // 键为块/边坐标："b" 或 "b:s->t"
  liveIn: Record<string, string[]>;
  liveOut: Record<string, string[]>;
  edgeOut: Record<string, string[]>;   // 按前驱边分开的 phi 使用
  // 每条指令后（坐标 inst id）的活跃集合
  liveAfter: Record<string, string[]>;
  liveRanges: Record<string, { unit: string; points: string[] }>;
}

export type InterfReason =
  | { kind: "live-at"; point: string; edge?: string }
  | { kind: "move-excluded"; instId: string }
  | { kind: "precolor-fixed"; preg: string }
  | { kind: "call-clobber"; instId: string; preg: string }
  | { kind: "phi-edge"; edge: string };

export interface InterfEdge {
  id: string;               // int:<a>~<b> 稳定
  a: string;
  b: string;
  reasons: InterfReason[]; // 证据
}

export interface InterferenceData {
  nodes: string[];
  edges: InterfEdge[];
  fixedNodes: string[];    // 预着色 preg
}

export interface CoalesceCandidate {
  moveId: string;
  dst: string;
  src: string;
  dstCls: string;
  srcCls: string;
  adoptable: boolean;
  rejectReason?: string;     // 不同 register class 不错误合并 / 干涉
}

export interface CoalesceDecision {
  moveId: string;
  adopted: boolean;
  reason: string;
  source: "auto" | "manual";
  legalAlternatives: string[]; // 无法唯一决定时全部合法候选
}

export interface StackEntry {
  id: string;
  reg: string;
  cls: string;
  kind: "low-degree" | "potential-spill";
  degree: number;
  candidatesConsidered?: string[];
}

export interface ColorChoice {
  reg: string;
  cls: string;
  color: string;            // preg 或 SPILL
  available: string[];
  rejected: string[];
  reason: string;
  fixed?: boolean;
}

export interface SpillCandidate {
  reg: string;
  cost: number;
  unit: string;
  detail: { use: number; def: number; move: number; depth: number };
  chosen: boolean;
  rejectReason?: string;
}

export interface SpillRewrite {
  reg: string;
  before: { instructionIds: string[]; text: string[] };
  after: { instructionIds: string[]; text: string[] };
  stores: string[];
  loads: string[];
  slotId: string;
}

export interface AllocResult {
  status: "ok" | "semantic-unsatisfiable" | "resource-exhausted";
  paramsVersion: string;
  inputSummary: { sourceSha256: string; instCount: number; vregCount: number };
  parentGenId: string | null;
  liveness: LivenessData;
  interference: InterferenceData;
  coalesceCandidates: CoalesceCandidate[];
  coalesceDecisions: CoalesceDecision[];
  simplifyStack: StackEntry[];
  colors: ColorChoice[];
  spillCosts: SpillCandidate[];
  chosenSpill: string | null;
  spillRewrite: SpillRewrite | null;
  unsatisfiable?: { reg: string; reason: string; evidence: string[] };
  rewriteGenId?: string;
  round: number;
  evidence: ReplayEvent[]; // 机器可读取的判定事件
}

// ---- 机器可读事件 ----
export type EventType =
  | "IMPORT" | "ANALYZE" | "PARAM_REVISION" | "SOURCE_PATCH"
  | "DECISION" | "ACCEPT" | "REJECT" | "PARAM_ADJUST" | "BRANCH"
  | "COALESCE_CHECK" | "SPILL_SELECT" | "REWRITE" | "CONFLICT";

export interface ReplayEvent {
  id: string;
  type: EventType;
  at: string;                 // ISO 时间基准
  basis: string;              // 判定依据（规则条目/材料坐标）
  inputSummary?: unknown;
  paramsVersion?: string;
  parentId?: string | null;
  payload?: unknown;
}

export interface ProjectBundle {
  format: "regalloc-archive";
  formatVersion: string;
  project: {
    id: string;
    name: string;
    branch: string;
  };
  materials: { id: string; branch: string; sourceText: string; createdAt: string }[];
  params: { id: string; parentId: string | null; version: string; params: AllocParams; createdAt: string }[];
  decisions: { id: string; moveId: string; adopted: boolean; reason: string; parentId: string | null; createdAt: string }[];
  events: PersistedEvent[];
  generations: PersistedGeneration[];
}

export interface PersistedEvent extends ReplayEvent {}

export interface PersistedGeneration {
  id: string;
  branch: string;
  materialId: string;
  paramsId: string;
  decisionSetId: string;
  parentGenId: string | null;
  round: number;
  result: AllocResult;
  createdAt: string;
}
