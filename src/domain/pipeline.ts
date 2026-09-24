import type {
  DomainEvent,
  Instruction,
  Materials,
  MoveStatus,
  PipelineParams,
  PipelineResult,
  RewriteEntry,
} from './types.js';
import { canonical, sha256 } from './util.js';
import { computeLiveness, type Emit } from './liveness.js';
import { briggsOk, buildGraph, graphHasEdge } from './interference.js';
import { colorGraph, graphViews, simplify } from './allocate.js';
import { spillRewrite } from './spill.js';
import { cloneInstrs } from './instr.js';


export function paramFingerprint(params: PipelineParams): string {
  return 'fp_' + sha256(canonical(params)).slice(0, 12);
}

export function runPipeline(materials: Materials, params: PipelineParams): PipelineResult {
  const events: DomainEvent[] = [];
  const diagnostics = materials.diagnostics.map((d) => ({ ...d }));
  const iterations: PipelineResult['iterations'] = [];
  const rewriteDiff: RewriteEntry[] = [];

  const emit: Emit = (iteration, kind, summary, detail) => {
    const id = 'ev_' + sha256(canonical({ kind, iteration, detail })).slice(0, 12);
    events.push({ id, iteration, kind, summary, detail });
  };

  const movesStatus = new Map<string, MoveStatus>();
  for (const mv of materials.moves) {
    movesStatus.set(mv.instrId, {
      instrId: mv.instrId,
      from: mv.from,
      to: mv.to,
      status: mv.fromClass === mv.toClass ? 'pending' : 'cross_class_kept',
    });
    if (mv.fromClass !== mv.toClass) {
      emit(0, 'class_merge_rejected',
        `跨类 move ${mv.instrId}（${mv.from}:${mv.fromClass} -> ${mv.to}:${mv.toClass}）不合并寄存器类`,
        { instrId: mv.instrId, fromClass: mv.fromClass, toClass: mv.toClass, from: mv.from, to: mv.to });
    }
  }

  const precolorMap = new Map(materials.precolors.map((p) => [p.vreg, p.phys]));
  let instrs: Instruction[] = cloneInstrs(materials.instructions);
  let coalesceDone = false;

  const fail = (status: PipelineResult['status'], message: string): PipelineResult => ({
    status,
    failure: message,
    diagnostics,
    events,
    iterations,
    coloring: [],
    moves: [...movesStatus.values()],
    rewriteDiff,
    inputDigest: materials.digest,
    paramFingerprint: paramFingerprint(params),
  });

  for (let iteration = 0; ; iteration += 1) {
    if (iteration > params.maxIterations) {
      return fail('budget_exhausted', `溢出重写迭代超过资源预算 maxIterations=${params.maxIterations}`);
    }

    let live = computeLiveness(materials, instrs, emit, iteration);
    const pendingMoves = new Set(
      materials.moves.filter((m) => movesStatus.get(m.instrId)?.status === 'pending').map((m) => m.instrId),
    );
    let graph = buildGraph(materials, instrs, live, precolorMap, pendingMoves, emit, iteration);

    if (!coalesceDone) {
      coalesceDone = true;
      let changed = false;
      for (const mv of materials.moves) {
        if (mv.fromClass !== mv.toClass) continue;
        const status = movesStatus.get(mv.instrId)!;
        if (status.status !== 'pending') continue;
        const k = materials.classes.find((c) => c.name === mv.fromClass)!.regs.length;
        const from = precolorMap.get(mv.from) ?? mv.from;
        const to = precolorMap.get(mv.to) ?? mv.to;
        const interfere = graphHasEdge(graph, mv.fromClass, from, to);
        const briggs = briggsOk(graph, mv.fromClass, from, to, k);
        if (!interfere && briggs) {
          for (const i of instrs) {
            for (const u of i.uses) if (u.name === mv.from) u.name = mv.to;
            for (const p of i.phiUses) if (p.name === mv.from) p.name = mv.to;
            for (const d of i.defs) if (d.name === mv.from) d.name = mv.to;
          }
          instrs = instrs.filter((i) => i.id !== mv.instrId);
          status.status = 'coalesced';
          status.reason = 'Briggs 保守合并通过，move 删除（工作副本）';
          changed = true;
          rewriteDiff.push({
            iteration,
            kind: 'coalesce',
            summary: `coalesce 通过：${mv.from} 并入 ${mv.to}，删除 move ${mv.instrId}`,
            before: [`instr ${mv.instrId} @... move ${mv.to}:${mv.toClass} <- ${mv.from}:${mv.fromClass}`],
            after: [`${mv.from} 重命名为 ${mv.to}；move 已删除`],
          });
          emit(iteration, 'coalesced', `move ${mv.instrId} coalescing 成功，${mv.from} 并入 ${mv.to}`, {
            instrId: mv.instrId, from: mv.from, to: mv.to,
          });
        } else {
          status.status = 'kept';
          status.reason = interfere ? '源/目的已干涉，不能合并' : 'Briggs 合并后高度邻居过多';
          emit(iteration, 'coalesce_failed_move_kept',
            `coalescing 失败，move ${mv.instrId} 必须保留（${status.reason}）`,
            { instrId: mv.instrId, from: mv.from, to: mv.to, interfere, briggs, reason: status.reason });
        }
      }
      if (changed) {
        live = computeLiveness(materials, instrs, emit, iteration);
        graph = buildGraph(materials, instrs, live, precolorMap, new Set(), emit, iteration);
      }
    }

    if (graph.conflicts.length > 0) {
      for (const c of graph.conflicts) {
        emit(iteration, 'precolor_conflict',
          `预着色冲突：${c.a} 与 ${c.b} 都被钉在 ${c.phys} 且二者干涉`,
          c);
      }
      return fail('semantic_unsolvable',
        `预着色冲突无解：${graph.conflicts.map((c) => `${c.a}/${c.b}->${c.phys}`).join('; ')}`);
    }

    const simp = simplify(graph, materials, params, instrs, emit, iteration);
    iterations.push({
      index: iteration,
      liveSets: live.trace,
      graphs: graphViews(graph),
      simplifyStack: simp.kind === 'done' || simp.kind === 'spill' ? [...simp.stack] : [],
      spill: simp.kind === 'spill' ? simp.spill : null,
    });

    if (simp.kind === 'budget') {
      return fail('budget_exhausted', `简化步骤超过资源预算 simplifyBudget=${params.simplifyBudget}`);
    }
    if (simp.kind === 'unsolvable') {
      return fail('semantic_unsolvable', simp.reason);
    }
    if (simp.kind === 'spill') {
      const victim = simp.spill.victim;
      const rw = spillRewrite(instrs, victim, graph.vregClass, iteration);
      rewriteDiff.push(...rw.entries);
      emit(iteration, 'spill_rewrite_recomputed',
        `溢出 ${victim} 重写后重新计算活跃性与干涉图（新 vreg ${rw.newVregs.length} 个）`,
        { victim, iteration, newVregs: rw.newVregs });
      instrs = rw.instrs;
      continue;
    }

    const colored = colorGraph(graph, simp.stack, materials, precolorMap);
    if ('failure' in colored) {
      emit(iteration, 'color_failed', colored.failure, {});
      return fail('semantic_unsolvable', colored.failure);
    }
    return {
      status: 'ok',
      diagnostics,
      events,
      iterations,
      coloring: colored.coloring,
      moves: [...movesStatus.values()],
      rewriteDiff,
      inputDigest: materials.digest,
      paramFingerprint: paramFingerprint(params),
    };
  }
}

export { DEFAULT_PARAMS } from './default-params.js';
