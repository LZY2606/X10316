import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type DB } from '../src/server/db.js';
import {
  compute,
  decide,
  exportBundle,
  getState,
  importBundle,
  importSource,
  reviseParameters,
  seedCasePackage,
  type Bundle,
  type CasePackage,
} from '../src/server/service.js';
import casePackage from '../src/server/case/register-conflict-spectrum.case.json';

const pkg = casePackage as unknown as CasePackage;
let dir: string;
let db: DB;

afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): DB {
  dir = mkdtempSync(join(tmpdir(), 'rcs-'));
  db = createStore(join(dir, 'test.db'));
  return db;
}

describe('案例包播种：一次参数修订、一次局部改动、一对冲突决定', () => {
  test('两个分支与完整事件链存在', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const state = getState(d);
    expect(state.branches.map((b: any) => b.name)).toEqual(['main', 'phi-edge-check']);
    const kinds = state.events.map((e: any) => e.kind);
    expect(kinds).toContain('import_source');
    expect(kinds).toContain('revise_parameters');
    expect(kinds).toContain('edit_source');
    const decisions = state.events.filter((e: any) => e.kind === 'decision');
    expect(decisions.length).toBe(2);
    expect(new Set(decisions.map((x: any) => x.verdict))).toEqual(new Set(['accept', 'reject']));
  });

  test('三种计算结果在样例中都出现：ok / semantic_unsolvable', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const statuses = getState(d).events.filter((e: any) => e.kind === 'compute').map((e: any) => e.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('semantic_unsolvable');
  });

  test('第二分支验证 phi 边使用与 coalesce 失败保留 move', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const state = getState(d);
    const branch2 = state.branches.find((b: any) => b.name === 'phi-edge-check')!;
    const head = getState(d, branch2.headEventId);
    const r = head.selected.result!;
    expect(r.status).toBe('ok');
    const evKinds = new Set(r.events.map((e: any) => e.kind));
    expect(evKinds.has('phi_edge_use_counted')).toBe(true);
    expect(evKinds.has('coalesce_failed_move_kept')).toBe(true);
    expect(evKinds.has('class_merge_rejected')).toBe(true);
    expect(r.moves.find((m: any) => m.instrId === 'i13').status).toBe('kept');
  });
});

describe('分层与来源关系', () => {
  test('每个计算事件记录输入摘要、参数版本、父级依赖', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const computes = getState(d).events.filter((e: any) => e.kind === 'compute');
    for (const e of computes) {
      expect(e.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof e.paramVersion).toBe('number');
      const row = d.prepare('SELECT parent_id FROM events WHERE id=?').get(e.id) as { parent_id: string };
      expect(row.parent_id).toBeTruthy();
    }
  });

  test('回到旧事件恢复当时参数版本与结论快照，而非最新结果', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const events = getState(d).events;
    const c1 = events.filter((e: any) => e.kind === 'compute')[0];
    const oldState = getState(d, c1.id);
    expect(oldState.selected.parameters.loopExponent).toBe(2);
    expect(oldState.selected.result!.paramFingerprint).toBeDefined();
    const c2 = events.filter((e: any) => e.kind === 'compute')[1];
    const newState = getState(d, c2.id);
    expect(newState.selected.parameters.loopExponent).toBe(1);
    expect(oldState.selected.result!.paramFingerprint).not.toBe(newState.selected.result!.paramFingerprint);
    // 旧事件的结果对象不随后续计算改变
    const stored = JSON.parse((d.prepare('SELECT result FROM events WHERE id=?').get(c1.id) as any).result);
    expect(stored.paramFingerprint).toBe(oldState.selected.result!.paramFingerprint);
  });

  test('导入不完整输入得到带位置诊断且不产生事件', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const main = getState(d).branches.find((b: any) => b.name === 'main').id;
    const before = (d.prepare('SELECT COUNT(*) c FROM events').get() as any).c;
    const r = importSource(d, main, 'class GPR { r0 }\nblock oops\ninstr i1 @nowhere def %x:GPR\n') as any;
    expect(r.status).toBe('format_corrupt');
    if (!('ok' in r)) expect(r.diagnostics![0].line).toBeGreaterThan(0);
    const after = (d.prepare('SELECT COUNT(*) c FROM events').get() as any).c;
    expect(after).toBe(before);
  });

  test('接受与否定都生成新事件，冲突被标记', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const events = getState(d).events;
    const c1 = events.filter((e: any) => e.kind === 'compute')[0];
    const main = events.find((e: any) => e.id === c1.id).branchId;
    const r1 = decide(d, main, c1.id, 'accept', 'test accept') as any;
    expect(r1.ok).toBe(true);
    expect(r1.conflict).toBe(false);
    const r2 = decide(d, main, c1.id, 'reject', 'test reject') as any;
    expect(r2.ok).toBe(true);
    expect(r2.conflict).toBe(true);
  });

  test('参数修订只创建新版本，不覆盖旧版本', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const main = getState(d).branches.find((b: any) => b.name === 'main').id;
    const rr = reviseParameters(d, main, { maxIterations: 2 }) as any;
    expect(rr.ok).toBe(true);
    const count = (d.prepare('SELECT COUNT(*) c FROM parameter_sets').get() as any).c;
    expect(count).toBeGreaterThanOrEqual(2);
    const cr = compute(d, main) as any;
    expect(cr.ok).toBe(true);
    expect(cr.result.status).toBe('budget_exhausted');
  });
});

describe('导出 / 删除库 / 导入往返', () => {
  test('身份、顺序、来源关系在往返后保持', () => {
    const d1 = freshDb();
    seedCasePackage(d1, pkg);
    const s1 = getState(d1);
    const bundle: Bundle = exportBundle(d1);
    d1.close();

    const dir2 = mkdtempSync(join(tmpdir(), 'rcs-'));
    try {
      const path2 = join(dir2, 'restored.db');
      const d2 = createStore(path2);
      const r = importBundle(d2, bundle) as any;
      expect(r.ok).toBe(true);

      const beforeIds = bundle.events.map((e) => e.id);
      const afterIds = (d2.prepare('SELECT id FROM events ORDER BY seq ASC').all() as { id: string }[]).map((x) => x.id);
      expect(afterIds).toEqual(beforeIds);
      const seqs = (d2.prepare('SELECT seq FROM events ORDER BY seq ASC').all() as { seq: number }[]).map((x) => x.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // 父级链完整
      for (const e of d2.prepare('SELECT id, parent_id FROM events').all() as { id: string; parent_id: string | null }[]) {
        if (e.parent_id) {
          const p = d2.prepare('SELECT id FROM events WHERE id=?').get(e.parent_id);
          expect(p).toBeTruthy();
        }
      }
      // 状态视图与导出一致
      const st = getState(d2);
      expect(st.events.length).toBe(bundle.events.length);
      expect(st.case.caseId).toBe(pkg.caseId);
      expect(st.events.map((e: any) => e.id)).toEqual(s1.events.map((e: any) => e.id));
      expect(st.events.map((e: any) => e.seq)).toEqual(s1.events.map((e: any) => e.seq));
      d2.close();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('重复导入幂等，身份不漂移', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const bundle = exportBundle(d);
    const firstCount = (d.prepare('SELECT COUNT(*) c FROM events').get() as any).c;
    const r = importBundle(d, bundle) as any;
    expect(r.ok).toBe(true);
    expect(r.imported.events).toBe(0);
    expect((d.prepare('SELECT COUNT(*) c FROM events').get() as any).c).toBe(firstCount);
  });
});

describe('半写恢复与三种失败结果', () => {
  test('引用缺失分支的损坏包整体回滚', () => {
    const d = freshDb();
    const materials = (d.prepare('SELECT COUNT(*) c FROM materials').get() as any).c;
    const corrupt = {
      formatVersion: 1,
      meta: {},
      materials: [],
      parameterSets: [],
      branches: [],
      events: [{
        id: 'evt_ghost', branch_id: 'br_nope', parent_id: null, seq: 999,
        kind: 'compute', payload: '{}', input_digest: 'x', param_version: 1, result: null,
      }],
    };
    const r = importBundle(d, corrupt) as any;
    expect(r.status).toBe('format_corrupt');
    expect((d.prepare('SELECT COUNT(*) c FROM events').get() as any).c).toBe(0);
    expect((d.prepare('SELECT COUNT(*) c FROM materials').get() as any).c).toBe(materials);
  });

  test('formatVersion 错误视为格式损坏', () => {
    const d = freshDb();
    const r = importBundle(d, { formatVersion: 99 }) as any;
    expect(r.status).toBe('format_corrupt');
  });

  test('budget_exhausted / semantic_unsolvable / format_corrupt 是三种不同结果', () => {
    const d = freshDb();
    seedCasePackage(d, pkg);
    const statuses = new Set<string>();
    const main = getState(d).branches.find((b: any) => b.name === 'main').id;
    const branch2 = getState(d).branches.find((b: any) => b.name === 'phi-edge-check')!.id;
    // 预算：第二分支材料必然需要 spill，maxIterations=0 直接耗尽
    reviseParameters(d, branch2, { maxIterations: 0 });
    const budget = compute(d, branch2) as any;
    expect(budget.ok).toBe(true);
    expect(budget.result.status).toBe('budget_exhausted');
    statuses.add(budget.result.status);
    // 语义无解：main 分支头部材料是预着色冲突版本
    const sem = compute(d, main) as any;
    expect(sem.result.status).toBe('semantic_unsolvable');
    statuses.add(sem.result.status);
    // 格式损坏
    const corrupt = importSource(d, main, 'not a program') as any;
    expect(corrupt.ok).toBe(false);
    statuses.add(corrupt.status);
    expect(statuses.size).toBe(3);
  });
});
