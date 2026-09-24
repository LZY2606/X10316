// ---------- 领域类型：不可变材料层 ----------
// 所有领域量都携带单位或坐标基准（Quantity / ProgramPoint）。

export interface Quantity {
  value: number;
  unit: string;          // 例如 "exec-frequency" | "spill-cost" | "bytes"
  basis?: string;        // 坐标/时间基准，例如 "static-loop-weight" 或 "block:<id>"
}

export interface ProgramPoint {
  func: string;
  block: string;
  index: number;         // 指令在块内的原始序号（原始顺序的坐标基准）
}

export interface RegisterClass {
  name: string;          // "GPR" | "FPR" ...
  regs: string[];        // 物理寄存器（预着色与 clobber 的坐标）
}

export interface VRegInfo {
  name: string;
  cls: string;           // register class 名
  spillCost?: Quantity;  // 可选人工标注的溢出代价（含单位）
}

export interface PhiArg { pred: string; vreg: string; }

export interface Instr {
  id: string;                    // 稳定身份
  op: string;                    // "phi" | "mov" | "add" | "call" | ...
  defs: string[];                // vreg 名
  uses: string[];                // vreg 名（phi 的边使用不在此列）
  phiArgs?: PhiArg[];            // phi：按前驱边记录使用
  isMove?: boolean;              // move 指令（coalescing 候选）
  clobbers?: string[];           // 物理寄存器 clobber（调用约定）
  point?: ProgramPoint;          // 原始顺序坐标（导入时补齐）
}

export interface Block {
  id: string;
  instrs: Instr[];               // 原始指令顺序，不可变材料
  successors: string[];          // CFG 边
  loopDepth?: number;            // 可显式标注；缺省时由回边推导
}

export interface Program {
  kind: 'program';
  func: string;
  entry: string;
  registerClasses: RegisterClass[];
  vregs: Record<string, VRegInfo>;
  precolors: Record<string, string>;       // vreg -> preg（预着色）
  callClobbers: Record<string, string[]>;  // 指令 id -> 物理寄存器 clobber 列表
  blocks: Block[];
}

// ---------- 参数层（可修订，带版本） ----------
export interface Params {
  kind: 'params';
  paramVersion: number;
  loopWeightBase: number;      // 循环权重底数（默认 10）
  maxIterations: number;       // spill 重写最大迭代（资源预算）
  simplifyBudget: number;      // 简化栈操作预算（资源预算）
  coalescing: boolean;
}

export const DEFAULT_PARAMS: Params = {
  kind: 'params',
  paramVersion: 1,
  loopWeightBase: 10,
  maxIterations: 8,
  simplifyBudget: 100000,
  coalescing: true,
};

// ---------- 诊断：带位置，绝不用空值/默认值伪装成功 ----------
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;                // 例如 "missing-field" | "unconvertible-unit"
  message: string;
  location?: string;           // 例如 "program.blocks[2].instrs[0].defs"
}

// ---------- 机器可读事件 ----------
export interface RaEvent {
  id: string;
  type: string;                // "liveness.computed" | "coalesce.failed" | ...
  inputDigest: string;         // 输入摘要
  paramVersion: number;
  parents: string[];           // 父级依赖（事件/材料 id）
  payload: unknown;
}

// ---------- 运行结果：三种失败是三种不同结果 ----------
export type RunStatus =
  | 'ok'
  | 'diagnostics'          // 输入不完整：带位置的诊断
  | 'format_corrupt'       // 格式损坏
  | 'semantic_unsolvable'  // 语义无解（如预着色冲突）
  | 'budget_exhausted';    // 资源预算耗尽

export interface RunResult {
  status: RunStatus;
  diagnostics: Diagnostic[];
  events: RaEvent[];
  inputDigest: string;
  paramVersion: number;
  view?: ReviewView;           // status === 'ok' 时存在
}

// ---------- 复核视图（页面展示所需的全部读回数据） ----------
export interface ReviewView {
  iterations: IterationView[];
  finalIteration: number;
}

export interface IterationView {
  iteration: number;
  liveSets: { block: string; liveIn: string[]; liveOut: string[]; edgeUses: Record<string, string[]> }[];
  interference: { nodes: string[]; classes: Record<string, string>; edges: [string, string][]; degrees: Record<string, number> };
  simplifyStack: { node: string; reason: 'low-degree' | 'spill-metric' | 'high-degree' }[];
  colors: Record<string, string>;            // vreg -> preg
  spillCosts: { vreg: string; cost: Quantity; degree: number }[];
  spilled: string[];
  coalesce: { moveId: string; from: string; to: string; result: 'merged' | 'kept' | 'cross-class-skipped'; reason: string }[];
  rewriteDiff?: RewriteDiff;                 // 溢出重写前后差异
}

export interface RewriteDiff {
  before: { point: ProgramPoint; text: string }[];
  after: { point: ProgramPoint; text: string }[];
  spilledVreg: string;
}
