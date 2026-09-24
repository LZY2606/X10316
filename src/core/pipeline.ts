import type { IterationView, Params, Program, RaEvent, RunResult } from './types';
import { digest, stableId } from './digest';
import { computeLiveness } from './liveness';
import { buildInterference, degrees } from './interference';
import { coalesce } from './coalesce';
import { simplifyAndSelect, spillCostOf } from './color';
import { rewriteSpills } from './rewrite';
import { validateProgram } from './parse';

// 主管线：liveness -> interference -> coalescing -> simplify/select -> spill rewrite -> 重算。
// 每一步都产出机器可读事件（输入摘要、参数版本、父级依赖）。
// 资源预算耗尽 / 格式损坏 / 语义无解是三种不同结果。

export interface RunContext { eventSeqStart?: number }

export function runPipeline(program: Program, params: Params, parents: string[] = []): RunResult {
  const events: RaEvent[] = [];
  const inputDigest = digest({ program, params });
  const emit = (type: string, payload: unknown, extraParents: string[] = []): RaEvent => {
    const ev: RaEvent = {
      id: stableId('ev', { type, payload, inputDigest, n: events.length }),
      type, inputDigest, paramVersion: params.paramVersion,
      parents: [...parents, ...extraParents], payload,
    };
    events.push(ev);
    return ev;
  };

  // 输入不完整 => 带位置诊断（不伪装成功）
  const validation = validateProgram(program);
  if (validation.some((d) => d.severity === 'error')) {
    emit('input.invalid', { diagnostics: validation });
    return { status: 'diagnostics', diagnostics: validation, events, inputDigest, paramVersion: params.paramVersion };
  }

  const iterations: IterationView[] = [];
  let current = program;

  for (let iter = 1; iter <= params.maxIterations; iter++) {
    const live = computeLiveness(current, params.loopWeightBase);
    const liveEv = emit('liveness.computed', {
      iteration: iter,
      blocks: current.blocks.map((b) => b.id).sort(),
      edgeUses: [...live.edgeUses.entries()].map(([k, v]) => ({ edge: k, vregs: [...v].sort() })),
      loopDepth: Object.fromEntries([...live.loopDepth.entries()].sort()),
      blockWeight: current.blocks.map((b) => ({ block: b.id, weight: live.blockWeight.get(b.id) })),
    });

    const g = buildInterference(current, live);
    const deg = degrees(g);
    const graphEv = emit('interference.built', {
      iteration: iter,
      nodes: [...g.nodes].sort(),
      classes: Object.fromEntries([...g.nodeClass.entries()].sort()),
      edges: [...g.adj.entries()].flatMap(([a, s]) => [...s].filter((b) => a < b).map((b) => [a, b])).sort(),
      degrees: Object.fromEntries([...deg.entries()].sort()),
    }, [liveEv.id]);

    const coalesceDecisions = coalesce(current, g, params.coalescing);
    const coalEv = emit('coalesce.decided', { iteration: iter, decisions: coalesceDecisions }, [graphEv.id]);

    const sel = simplifyAndSelect(current, g, live, params.simplifyBudget);
    if (sel.conflicts.length) {
      emit('precolor.conflict', { iteration: iter, conflicts: sel.conflicts }, [coalEv.id]);
      return {
        status: 'semantic_unsolvable',
        diagnostics: sel.conflicts.map((c) => ({
          severity: 'error' as const, code: 'precolor-conflict',
          message: `预着色冲突: ${c.a} 与 ${c.b} 都被约束到 ${c.preg} 但互相干涉`,
          location: `program.precolors.${c.a}`,
        })),
        events, inputDigest, paramVersion: params.paramVersion,
      };
    }
    if (sel.budgetExhausted) {
      emit('budget.exhausted', { iteration: iter, budget: params.simplifyBudget }, [coalEv.id]);
      return { status: 'budget_exhausted', diagnostics: [{ severity: 'error', code: 'budget-exhausted', message: `简化预算 ${params.simplifyBudget} 耗尽`, location: 'params.simplifyBudget' }], events, inputDigest, paramVersion: params.paramVersion };
    }

    const spillCosts = Object.keys(current.vregs)
      .filter((v) => g.nodes.has(v) || sel.stack.some((s) => s.node === v))
      .sort()
      .map((v) => ({ vreg: v, cost: spillCostOf(current, live, v), degree: deg.get(v) ?? 0 }));

    emit('select.done', {
      iteration: iter,
      stack: sel.stack,
      colors: Object.fromEntries(Object.entries(sel.colors).sort()),
      spillCosts,
      spilled: sel.spilled,
      highDegree: sel.stack.filter((s) => s.reason === 'spill-metric'),
    }, [coalEv.id]);

    const view: IterationView = {
      iteration: iter,
      liveSets: current.blocks.map((b) => ({
        block: b.id,
        liveIn: [...(live.liveIn.get(b.id) ?? [])].sort(),
        liveOut: [...(live.liveOut.get(b.id) ?? [])].sort(),
        edgeUses: Object.fromEntries(
          [...live.edgeUses.entries()].filter(([k]) => k.endsWith(`->${b.id}`)).map(([k, v]) => [k, [...v].sort()]),
        ),
      })),
      interference: {
        nodes: [...g.nodes].sort(),
        classes: Object.fromEntries([...g.nodeClass.entries()].sort()),
        edges: ([...g.adj.entries()].flatMap(([a, s]) => [...s].filter((b) => a < b).map((b) => [a, b])).sort()) as [string, string][],
        degrees: Object.fromEntries([...deg.entries()].sort()),
      },
      simplifyStack: sel.stack.map((s) => ({ node: s.node, reason: s.reason === 'low-degree' ? 'low-degree' : 'spill-metric' })),
      colors: Object.fromEntries(Object.entries(sel.colors).sort()),
      spillCosts,
      spilled: sel.spilled,
      coalesce: coalesceDecisions,
    };
    iterations.push(view);

    if (!sel.spilled.length) {
      emit('run.completed', { iterations: iter, status: 'ok' });
      return { status: 'ok', diagnostics: [], events, inputDigest, paramVersion: params.paramVersion, view: { iterations, finalIteration: iter } };
    }

    // 溢出重写后重新计算图（下一轮迭代）
    const { program: rewritten, diffs } = rewriteSpills(current, sel.spilled, iter);
    const rwEv = emit('spill.rewritten', { iteration: iter, spilled: sel.spilled, diffs }, [graphEv.id]);
    view.rewriteDiff = diffs[0]; // 视图保留首个差异；完整差异在事件中
    (view as { rewriteDiffs?: unknown }).rewriteDiffs = diffs;
    current = rewritten;
    void rwEv;
  }

  emit('budget.exhausted', { budget: params.maxIterations, kind: 'iterations' });
  return { status: 'budget_exhausted', diagnostics: [{ severity: 'error', code: 'budget-exhausted', message: `溢出重写迭代超过预算 ${params.maxIterations}`, location: 'params.maxIterations' }], events, inputDigest, paramVersion: params.paramVersion };
}
