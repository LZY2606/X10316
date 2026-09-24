import { describe, expect, test } from 'vitest';
import { parseMaterials } from '../src/domain/parse.js';
import { runPipeline, DEFAULT_PARAMS } from '../src/domain/pipeline.js';
import type { Materials, PipelineParams, PipelineResult } from '../src/domain/types.js';
import casePackage from '../src/server/case/register-conflict-spectrum.case.json';

const pkg = casePackage as unknown as { sources: Record<string, string>; parameters: PipelineParams };

function materialsOf(key: string): Materials {
  const parsed = parseMaterials(pkg.sources[key]);
  if (!parsed.ok) throw new Error('parse failed: ' + JSON.stringify(parsed.diagnostics));
  return parsed.materials;
}

function run(key: string, params: PipelineParams = DEFAULT_PARAMS): PipelineResult {
  return runPipeline(materialsOf(key), params);
}

const kinds = (r: PipelineResult) => new Set(r.events.map((e) => e.kind));

describe('phi 边使用按前驱边计入活跃性', () => {
  test('phi 使用出现在前驱块 live-out，而不是 phi 所在块 live-in', () => {
    const r = run('v1');
    expect(r.status).toBe('ok');
    expect(kinds(r)).toContain('phi_edge_use_counted');
    const phiEv = r.events.find((e) => e.kind === 'phi_edge_use_counted')!;
    expect(phiEv.detail).toMatchObject({ phi: 'i5', pred: 'entry', succ: 'loop', vreg: '%c' });
    const entry = r.iterations[0].liveSets.find((b) => b.block === 'entry')!;
    const loop = r.iterations[0].liveSets.find((b) => b.block === 'loop')!;
    expect(entry.liveOut).toContain('%c');
    expect(loop.liveIn).not.toContain('%c');
    const body = r.iterations[0].liveSets.find((b) => b.block === 'body')!;
    expect(body.liveOut).toContain('%s');
  });

  test('事件携带稳定身份，等价输入顺序稳定', () => {
    const a = run('v1');
    const b = run('v1');
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(a.coloring).toEqual(b.coloring);
  });
});

describe('预着色冲突 / 调用 clobber / 跨类 move', () => {
  test('调用 clobber 与跨调用活跃值干涉', () => {
    const r = run('v1');
    const ev = r.events.find((e) => e.kind === 'call_clobber_interference')!;
    expect(ev.detail.clobbers).toEqual(['r0', 'r1']);
    expect(ev.detail.liveAcross).toEqual(expect.arrayContaining(['%a', '%b', '%c']));
    const gpr = r.iterations[0].graphs.find((g) => g.className === 'GPR')!;
    const hasEdge = (x: string, y: string) =>
      gpr.edges.some(([a, b]) => (a === x && b === y) || (a === y && b === x));
    expect(hasEdge('%a', 'r0')).toBe(true);
    expect(hasEdge('%a', 'r1')).toBe(true);
  });

  test('跨类 move 不合并寄存器类', () => {
    const r = run('v1');
    expect(kinds(r)).toContain('class_merge_rejected');
    const gpr = r.iterations[0].graphs.find((g) => g.className === 'GPR')!;
    const fpr = r.iterations[0].graphs.find((g) => g.className === 'FPR')!;
    expect(gpr.nodes.find((n) => n.id === '%f')).toBeUndefined();
    expect(fpr.nodes.find((n) => n.id === '%f')).toBeDefined();
    const mv = r.moves.find((m) => m.instrId === 'i9')!;
    expect(mv.status).toBe('cross_class_kept');
  });

  test('预着色冲突是 semantic_unsolvable，与预算/格式失败区分', () => {
    const r = run('v1_precolor');
    expect(r.status).toBe('semantic_unsolvable');
    expect(kinds(r)).toContain('precolor_conflict');
  });
});

describe('高度节点 / 溢出重写 / 循环权重', () => {
  test('高度节点被记录，溢出后重写并重新计算图', () => {
    const r = run('v1');
    expect(kinds(r)).toContain('high_degree_node');
    expect(kinds(r)).toContain('spill_choice');
    expect(kinds(r)).toContain('spill_rewrite_recomputed');
    expect(r.iterations.length).toBeGreaterThan(1);
    expect(r.rewriteDiff.filter((d) => d.kind === 'spill_rewrite').length).toBeGreaterThan(0);
    // 每次 spill 之后都有新一轮图
    const recomputes = r.events.filter((e) => e.kind === 'spill_rewrite_recomputed');
    expect(recomputes[0].detail.iteration).toBe(0);
    // 最终着色完整合法
    const spilled = new Set(recomputes.map((e) => e.detail.victim as string));
    expect(spilled.size).toBeGreaterThan(0);
    for (const c of r.coloring) {
      const cls = materialsOf('v1').classes.find((x) => x.name === c.cls)!;
      expect(cls.regs).toContain(c.color);
    }
    const retv = r.coloring.find((c) => c.vreg === '%retv');
    expect(retv?.color).toBe('r0');
  });

  test('spill 代价携带单位 cycle，循环块权重放大代价', () => {
    const r = run('v1');
    const firstSpill = r.iterations[0].spill!;
    const a = firstSpill.candidates.find((c) => c.node === '%a')!;
    const b = firstSpill.candidates.find((c) => c.node === '%b')!;
    expect(a.cost.unit).toBe('cycle');
    expect(a.cost.basis).toContain('loopExponent=2');
    expect(a.cost.value).not.toBeNull();
    expect(b.cost.value).toBeGreaterThan(a.cost.value!);
    expect(kinds(r)).toContain('loop_weight_applied');
  });

  test('并列时保留全部合法候选', () => {
    const r = run('v1');
    const tied = r.events.find((e) => e.kind === 'spill_candidates_tied');
    if (tied) expect((tied.detail.tied as string[]).length).toBeGreaterThan(1);
    for (const it of r.iterations) {
      if (it.spill && it.spill.tied.length > 1) {
        expect(it.spill.candidates.map((c) => c.node)).toEqual(
          expect.arrayContaining(it.spill.tied),
        );
      }
    }
  });

  test('coalescing 失败不能删 move（第二分支同类 move）', () => {
    const r = run('v2_move');
    const ev = r.events.find((e) => e.kind === 'coalesce_failed_move_kept')!;
    expect(ev.detail.instrId).toBe('i13');
    const mv = r.moves.find((m) => m.instrId === 'i13')!;
    expect(mv.status).toBe('kept');
    // 最终指令（含 spill 重写）中仍可找到 i13 或其未被 coalesce 的痕迹：rewriteDiff 不含 i13 coalesce
    expect(r.rewriteDiff.some((d) => d.kind === 'coalesce' && d.summary.includes('i13'))).toBe(false);
  });

  test('资源预算耗尽是独立结果', () => {
    const r = run('v1', { ...DEFAULT_PARAMS, maxIterations: 0 });
    expect(r.status).toBe('budget_exhausted');
    expect(r.failure).toContain('maxIterations');
  });

  test('不可转换单位留在原位并附诊断，不伪造决策', () => {
    const r = run('bad_weight');
    expect(r.status).toBe('semantic_unsolvable');
    const m = materialsOf('bad_weight');
    const loop = m.blocks.find((b) => b.name === 'loop')!;
    expect(loop.weight.raw).toBe('10 frob');
    expect(loop.weight.diagnostic).toContain('未知单位');
    expect(m.diagnostics.length).toBeGreaterThan(0);
    const spilledCost = r.iterations.flatMap((i) => i.spill?.candidates ?? [])
      .find((c) => c.cost.value === null);
    expect(spilledCost?.cost.diagnostic).toBeTruthy();
  });
});

describe('格式损坏', () => {
  test('不完整输入返回带位置诊断', () => {
    const bad = `class GPR { r0 }\nblock entry weight\ninstr i1 @entry def %a:GPR\n`;
    const parsed = parseMaterials(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics.length).toBeGreaterThan(0);
      expect(parsed.diagnostics[0].line).toBeGreaterThan(0);
    }
  });

  test('未知行 / 缺失类 / 缺失块均是带位置 error', () => {
    const parsed = parseMaterials('nonsense line\nblock b weight 1 exec\ninstr i1 @missing def %x:GPR op nop\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const lines = parsed.diagnostics.map((d) => d.line);
      expect(lines).toContain(1);
      expect(parsed.diagnostics.some((d) => d.message.includes('@missing'))).toBe(true);
    }
  });
});
