import type { Params, Program, RunResult } from '../core/types';
import { DEFAULT_PARAMS } from '../core/types';
import { parseProgram } from '../core/parse';
import { runPipeline } from '../core/pipeline';
import { digest, stableId, resetIdCounter } from '../core/digest';
import type { Store } from './store';

// 离线案例包：「寄存器冲突谱：活跃区间、干涉图与溢出决策回放」。
// 叙事：后端工程组导入 SSA/虚拟寄存器指令 + 物理寄存器类 + 调用约定，
// 审阅 liveness -> interference -> coalescing -> spill 全链。
// 初始版本完整保留原始材料；随后一次参数修订、一次局部源数据改动、
// 一次互相冲突的人工决定；第二分支专验 phi 边使用与类分离等不变量。

export const CASEPACK_ID = 'casepack-register-conflict-spectrum';

const BASELINE_DSL = `# 寄存器冲突谱基线：循环 + phi + 调用 clobber + 跨类 move + 预着色
func loop_kernel
class GPR r0 r1 r2 r3
class FPR f0 f1
vreg p GPR
vreg n GPR
vreg t0 GPR
vreg acc GPR
vreg i GPR
vreg t1 GPR
vreg t2 GPR
vreg t3 GPR
vreg i2 GPR
vreg i3 GPR
vreg retv GPR
vreg x FPR
vreg y FPR
vreg xf FPR
precolor p r0
precolor n r1
precolor retv r0
block entry
  e0: li defs=t0
  e1: mov defs=acc uses=t0 move
  e2: li defs=i
  succ header
block header
  h0: phi defs=t1 args=entry:acc,body:t3
  h1: phi defs=i2 args=entry:i,body:i3
  h2: sub defs=t2 uses=n,i2
  h3: br uses=t2
  succ body exit
block body
  b0: load defs=x uses=p,i2
  b1: load defs=y uses=p,t1
  b2: fma defs=xf uses=x,y,t1
  b3: mov defs=t3 uses=xf move
  b4: call uses=t3 clobbers=r2
  b5: add defs=i3 uses=i2
  succ header
block exit
  x0: mov defs=retv uses=t1 move
  x1: ret uses=retv`;

// 局部源数据改动：只改 exit 块一条指令（t2-live 延伸到 exit）
const LOCAL_CHANGE_DSL = BASELINE_DSL.replace('x1: ret uses=retv', 'x1: ret uses=retv,t2');

// 预着色冲突：t1 预着色到 r2，但 t1 跨越 clobber r2 的调用点
const CONFLICT_DSL = BASELINE_DSL.replace('precolor retv r0', 'precolor retv r0\nprecolor t1 r2');

// 第二分支：phi 边使用专验（m 只在 right->join 边上被 phi 使用）
const PHI_EDGE_DSL = `# phi 边使用专验：m 只经 right->join 边进入活跃性
func phi_edge_case
class GPR r0 r1 r2
vreg a GPR
vreg m GPR
vreg z GPR
vreg z2 GPR
block entry
  p0: li defs=a
  p1: li defs=m
  succ left right
block left
  l0: add defs=z uses=a
  succ join
block right
  r0i: nop
  succ join
block join
  j0: phi defs=z2 args=left:z,right:m
  j1: ret uses=z2`;

function mustParse(dsl: string, label: string): Program {
  const out = parseProgram(dsl);
  if (!out.program) throw new Error(`案例包 ${label} 解析失败: ${JSON.stringify(out.diagnostics)}`);
  return out.program;
}

export interface SeedSummary {
  materials: number; events: number; decisions: number; branches: string[];
  runs: { label: string; status: RunResult['status']; digest: string }[];
}

export function seedCasePack(store: Store): SeedSummary {
  resetIdCounter(0);
  const runs: SeedSummary['runs'] = [];
  let seq = 1;
  const now = () => new Date().toISOString();

  const putProgram = (dsl: string, version: number, parentId: string | null, label: string): { id: string; program: Program } => {
    const program = mustParse(dsl, label);
    const id = `mat-prog-v${version}-${digest(program)}`;
    store.putMaterial({ id, kind: 'program', version, content: JSON.stringify({ dsl, program }), digest: digest(program), parent_id: parentId, created_event: null });
    return { id, program };
  };
  const putParams = (params: Params, parentId: string | null): string => {
    const id = `mat-params-v${params.paramVersion}-${digest(params)}`;
    store.putMaterial({ id, kind: 'params', version: params.paramVersion, content: JSON.stringify(params), digest: digest(params), parent_id: parentId, created_event: null });
    return id;
  };
  const recordRun = (branch: string, label: string, progId: string, paramsId: string, program: Program, params: Params): RunResult => {
    const result = runPipeline(program, params, [progId, paramsId]);
    for (const ev of result.events) {
      store.putEvent({
        id: ev.id, seq: seq++, branch, type: ev.type,
        input_digest: ev.inputDigest, param_version: ev.paramVersion,
        parents: JSON.stringify(ev.parents), payload: JSON.stringify(ev.payload), created_at: now(),
      });
    }
    const runId = stableId('run', { label, digest: result.inputDigest, status: result.status });
    store.putMaterial({
      id: runId, kind: 'run', version: 1,
      content: JSON.stringify({ label, status: result.status, diagnostics: result.diagnostics, view: result.view ?? null, inputDigest: result.inputDigest, paramVersion: result.paramVersion, programId: progId, paramsId }),
      digest: result.inputDigest, parent_id: progId, created_event: result.events.at(-1)?.id ?? null,
    });
    const br = store.getBranch(branch);
    store.putBranch({ id: branch, name: branch, head_event: result.events.at(-1)?.id ?? br?.head_event ?? null });
    runs.push({ label, status: result.status, digest: result.inputDigest });
    return result;
  };

  store.putBranch({ id: 'main', name: 'main', head_event: null });
  store.putBranch({ id: 'branch/phi-edge', name: 'branch/phi-edge', head_event: null });

  // 1) 基线：原指令顺序、def/use、CFG、寄存器类、预着色、clobber、move 全部保留
  const prog1 = putProgram(BASELINE_DSL, 1, null, 'baseline');
  const params1 = putParams({ ...DEFAULT_PARAMS }, null);
  const run1 = recordRun('main', 'baseline: 全链审阅 (liveness→interference→coalescing→spill)', prog1.id, params1.id, prog1.program, { ...DEFAULT_PARAMS });

  // 2) 参数修订：paramVersion 2，关闭 coalescing
  const params2: Params = { ...DEFAULT_PARAMS, paramVersion: 2, coalescing: false };
  const params2Id = putParams(params2, params1);
  recordRun('main', '参数修订: coalescing=false (paramVersion=2)', prog1.id, params2Id, prog1.program, params2);

  // 3) 局部源数据改动：exit 块 ret 增加 use t2
  const prog2 = putProgram(LOCAL_CHANGE_DSL, 2, prog1.id, 'local-change');
  recordRun('main', '局部源改动: exit.ret 增加 use t2 (program v2)', prog2.id, params1, prog2.program, { ...DEFAULT_PARAMS });

  // 4) 预着色冲突：t1 -> r2 与调用 clobber r2 冲突 => 语义无解
  const prog3 = putProgram(CONFLICT_DSL, 3, prog1.id, 'precolor-conflict');
  recordRun('main', '边界组合: 预着色 t1=r2 撞上调用 clobber r2 (program v3)', prog3.id, params1, prog3.program, { ...DEFAULT_PARAMS });

  // 5) 互相冲突的人工决定：针对 run1 中 move x0 的 coalesce 决定
  const coalEv = run1.events.find((e) => e.type === 'coalesce.decided');
  const target = coalEv?.id ?? 'unknown';
  const d1 = stableId('dec', { reviewer: 'reviewer-A', target });
  store.putDecision({
    id: d1, seq: store.nextSeq('decisions'), branch: 'main', target,
    action: 'accept', status: 'adopted',
    payload: JSON.stringify({ moveId: 'x0', verdict: 'kept', scope: 'coalesce' }),
    rationale: 'George 准则不满足，保留 move 是正确的', created_at: now(),
  });
  const d2 = stableId('dec', { reviewer: 'reviewer-B', target });
  store.putDecision({
    id: d2, seq: store.nextSeq('decisions'), branch: 'main', target,
    action: 'reject', status: 'recorded',
    payload: JSON.stringify({ moveId: 'x0', verdict: 'should-merge', scope: 'coalesce' }),
    rationale: '认为应强制合并 retv/t1（与 A 冲突，两条都保留）', created_at: now(),
  });

  // 6) 第二分支：phi 边使用 / 类分离 / coalesce 失败保留 move / spill 重算
  const progPhi = putProgram(PHI_EDGE_DSL, 1, null, 'phi-edge');
  recordRun('branch/phi-edge', 'phi 边使用专验: m 仅经 right->join 边计入活跃性', progPhi.id, params1, progPhi.program, { ...DEFAULT_PARAMS });

  const materials = store.listMaterials().length;
  const events = store.listEvents().length;
  const decisions = store.listDecisions().length;
  return { materials, events, decisions, branches: ['main', 'branch/phi-edge'], runs };
}
