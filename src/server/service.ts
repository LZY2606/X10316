import type { DB } from './db.js';
import type { Diagnostic, PipelineParams, PipelineResult } from '../domain/types.js';
import { parseMaterials } from '../domain/parse.js';
import { runPipeline, paramFingerprint } from '../domain/pipeline.js';
import { DEFAULT_PARAMS } from '../domain/default-params.js';
import { canonical, sha256 } from '../domain/util.js';

export interface Failure {
  ok: false;
  status: 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';
  message?: string;
  diagnostics?: Diagnostic[];
}

interface EventRow {
  id: string;
  branch_id: string;
  parent_id: string | null;
  seq: number;
  kind: string;
  payload: string;
  input_digest: string;
  param_version: number;
  result: string | null;
}

interface CaseScriptOp {
  op: string;
  branch?: string;
  source?: string;
  as?: string;
  on?: string;
  from?: string;
  verdict?: string;
  rationale?: string;
  patch?: Partial<PipelineParams>;
}

export interface CasePackage {
  caseId: string;
  title: string;
  summary?: string;
  units?: Record<string, string>;
  parameters: PipelineParams;
  sources: Record<string, string>;
  script: CaseScriptOp[];
}

// ---------- low level ----------

function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function nextSeq(db: DB): number {
  const current = getMeta(db, 'seq');
  const seq = (current ? parseInt(current, 10) : 0) + 1;
  setMeta(db, 'seq', String(seq));
  return seq;
}

export function createBranch(db: DB, name: string): string {
  const existing = db.prepare('SELECT id FROM branches WHERE name = ?').get(name) as { id: string } | undefined;
  if (existing) return existing.id;
  const seq = nextSeq(db);
  const id = 'br_' + sha256(canonical({ name, seq })).slice(0, 12);
  db.prepare('INSERT INTO branches(id, name, created_seq) VALUES(?, ?, ?)').run(id, name, seq);
  return id;
}

interface AppendArgs {
  branchId: string;
  parentId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  inputDigest: string;
  paramVersion: number;
  result?: PipelineResult | null;
}

function appendEvent(db: DB, args: AppendArgs): EventRow {
  const seq = nextSeq(db);
  const id = 'evt_' + sha256(canonical({
    branch: args.branchId, parent: args.parentId, kind: args.kind, payload: args.payload, seq,
  })).slice(0, 16);
  db.prepare(
    `INSERT INTO events(id, branch_id, parent_id, seq, kind, payload, input_digest, param_version, result)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, args.branchId, args.parentId, seq, args.kind,
    JSON.stringify(args.payload), args.inputDigest, args.paramVersion,
    args.result ? JSON.stringify(args.result) : null,
  );
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow;
}

export function branchHead(db: DB, branchId: string): EventRow | null {
  return (db.prepare('SELECT * FROM events WHERE branch_id = ? ORDER BY seq DESC LIMIT 1').get(branchId) as unknown as EventRow | undefined) ?? null;
}

export function listEvents(db: DB): EventRow[] {
  return db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as EventRow[];
}

function walkChain(db: DB, startId: string | null): EventRow[] {
  const chain: EventRow[] = [];
  const byId = new Map((db.prepare('SELECT * FROM events').all() as unknown as EventRow[]).map((e) => [e.id, e]));
  let cur = startId ? byId.get(startId) ?? null : null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) ?? null : null;
  }
  return chain;
}

interface Context {
  headId: string | null;
  materialsId: string | null;
  parameterSetId: string;
  paramVersion: number;
}

function resolveContext(db: DB, branchId: string, fromEventId?: string | null): Context {
  const start = fromEventId ?? branchHead(db, branchId)?.id ?? null;
  const chain = walkChain(db, start);
  let materialsId: string | null = null;
  let parameterSetId: string | null = null;
  for (const e of chain) {
    if (!materialsId && (e.kind === 'import_source' || e.kind === 'edit_source')) {
      materialsId = (JSON.parse(e.payload) as { materialsId: string }).materialsId;
    }
    if (!parameterSetId && e.kind === 'revise_parameters') {
      parameterSetId = (JSON.parse(e.payload) as { parameterSetId: string }).parameterSetId;
    }
  }
  const defaultId = getMeta(db, 'defaultParameterSetId')!;
  const psId = parameterSetId ?? defaultId;
  const psRow = db.prepare('SELECT version FROM parameter_sets WHERE id = ?').get(psId) as { version: number };
  return { headId: start, materialsId, parameterSetId: psId, paramVersion: psRow.version };
}

// ---------- parameter sets ----------

export function upsertParameterSet(
  db: DB,
  parentId: string | null,
  params: PipelineParams,
  version?: number,
): { id: string; version: number } {
  const parentVersion = parentId
    ? (db.prepare('SELECT version FROM parameter_sets WHERE id = ?').get(parentId) as { version: number } | undefined)?.version ?? 0
    : 0;
  const ver = version ?? parentVersion + 1;
  const id = 'ps_' + sha256(canonical({ params, parent: parentId, ver })).slice(0, 12);
  db.prepare(
    `INSERT OR IGNORE INTO parameter_sets(id, version, payload, parent_id, created_seq)
     VALUES(?, ?, ?, ?, ?)`,
  ).run(id, ver, JSON.stringify(params), parentId, nextSeq(db));
  return { id, version: ver };
}

export function getParameters(db: DB, id: string): PipelineParams {
  const row = db.prepare('SELECT payload FROM parameter_sets WHERE id = ?').get(id) as { payload: string };
  return JSON.parse(row.payload) as PipelineParams;
}

// ---------- commands ----------

export function importSource(
  db: DB,
  branchId: string,
  source: string,
): { ok: true; eventId: string; materialsId: string } | Failure {
  const parsed = parseMaterials(source);
  if (!parsed.ok) {
    return { ok: false, status: 'format_corrupt', message: '源文本解析失败', diagnostics: parsed.diagnostics };
  }
  const materials = parsed.materials;
  const head = branchHead(db, branchId);
  const ctx = resolveContext(db, branchId);
  db.prepare(
    'INSERT OR IGNORE INTO materials(id, source, digest, created_seq) VALUES(?, ?, ?, ?)',
  ).run(materials.id, materials.source, materials.digest, nextSeq(db));

  const isEdit = Boolean(ctx.materialsId);
  const payload: Record<string, unknown> = {
    materialsId: materials.id,
    digest: materials.digest,
    lines: source.split(/\r?\n/).length,
  };
  if (isEdit) payload.baseMaterialsId = ctx.materialsId;
  const row = appendEvent(db, {
    branchId,
    parentId: head?.id ?? null,
    kind: isEdit ? 'edit_source' : 'import_source',
    payload,
    inputDigest: materials.digest,
    paramVersion: ctx.paramVersion,
  });
  return { ok: true, eventId: row.id, materialsId: materials.id };
}

export function reviseParameters(db: DB, branchId: string, patch: Partial<PipelineParams>): { ok: true; eventId: string; parameterSetId: string; version: number } | Failure {
  const ctx = resolveContext(db, branchId);
  if (!ctx.materialsId) return { ok: false, status: 'format_corrupt', message: '分支还没有材料，无法修订参数' };
  const current = getParameters(db, ctx.parameterSetId);
  const nextParams: PipelineParams = {
    loopExponent: patch.loopExponent ?? current.loopExponent,
    maxIterations: patch.maxIterations ?? current.maxIterations,
    simplifyBudget: patch.simplifyBudget ?? current.simplifyBudget,
    storeCost: patch.storeCost ?? current.storeCost,
    loadCost: patch.loadCost ?? current.loadCost,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
      return { ok: false, status: 'format_corrupt', message: `参数 ${k} 必须是非负有限数，收到 ${String(v)}` };
    }
  }
  const head = branchHead(db, branchId);
  const ps = upsertParameterSet(db, ctx.parameterSetId, nextParams);
  const payload = {
    parameterSetId: ps.id,
    version: ps.version,
    baseParameterSetId: ctx.parameterSetId,
    patch,
  };
  const row = appendEvent(db, {
    branchId,
    parentId: head?.id ?? null,
    kind: 'revise_parameters',
    payload,
    inputDigest: sha256(canonical({ params: nextParams })),
    paramVersion: ps.version,
  });
  return { ok: true, eventId: row.id, parameterSetId: ps.id, version: ps.version };
}

export function compute(db: DB, branchId: string): { ok: true; eventId: string; result: PipelineResult } | Failure {
  const ctx = resolveContext(db, branchId);
  if (!ctx.materialsId) return { ok: false, status: 'format_corrupt', message: '分支还没有材料，无法计算' };
  const matRow = db.prepare('SELECT source FROM materials WHERE id = ?').get(ctx.materialsId) as { source: string };
  const parsed = parseMaterials(matRow.source);
  if (!parsed.ok) return { ok: false, status: 'format_corrupt', message: '存储的材料无法解析', diagnostics: parsed.diagnostics };
  const params = getParameters(db, ctx.parameterSetId);
  const result = runPipeline(parsed.materials, params);
  const head = branchHead(db, branchId);
  const digest = sha256(canonical({ materials: ctx.materialsId, params: ctx.parameterSetId }));
  const payload = {
    materialsId: ctx.materialsId,
    parameterSetId: ctx.parameterSetId,
    status: result.status,
    eventCount: result.events.length,
    spillIterations: result.iterations.length,
  };
  const row = appendEvent(db, {
    branchId,
    parentId: head?.id ?? null,
    kind: 'compute',
    payload,
    inputDigest: digest,
    paramVersion: ctx.paramVersion,
    result,
  });
  if (result.status !== 'ok') {
    return { ok: true as const, eventId: row.id, result };
  }
  return { ok: true, eventId: row.id, result };
}

export function decide(
  db: DB,
  branchId: string,
  onEventId: string,
  verdict: 'accept' | 'reject',
  rationale: string,
): { ok: true; eventId: string; conflict: boolean } | Failure {
  const target = db.prepare('SELECT * FROM events WHERE id = ?').get(onEventId) as unknown as EventRow | undefined;
  if (!target) return { ok: false, status: 'format_corrupt', message: `决定目标事件不存在: ${onEventId}` };
  if (target.kind !== 'compute') return { ok: false, status: 'format_corrupt', message: '只能对 compute 事件做接受/否定决定' };
  const head = branchHead(db, branchId);
  const ctx = resolveContext(db, branchId);
  const existing = db.prepare("SELECT payload FROM events WHERE kind = 'decision'").all() as { payload: string }[];
  const conflict = existing.some((r) => {
    const p = JSON.parse(r.payload) as { onEventId: string; verdict: string };
    return p.onEventId === onEventId && p.verdict !== verdict;
  });
  const row = appendEvent(db, {
    branchId,
    parentId: head?.id ?? null,
    kind: 'decision',
    payload: { onEventId, verdict, rationale: rationale || '', conflict },
    inputDigest: target.input_digest,
    paramVersion: ctx.paramVersion,
  });
  return { ok: true, eventId: row.id, conflict };
}

// ---------- queries ----------

function eventSummary(e: EventRow): string {
  const p = JSON.parse(e.payload) as Record<string, unknown>;
  switch (e.kind) {
    case 'import_source':
      return `导入材料 ${String(p.materialsId)}`;
    case 'edit_source':
      return `局部源数据改动 ${String(p.materialsId)}（基线 ${String(p.baseMaterialsId)}）`;
    case 'revise_parameters':
      return `参数修订 v${String(p.version)}: ${JSON.stringify(p.patch)}`;
    case 'compute':
      return `计算 #${String(p.spillIterations)} 轮 → ${String(p.status)}`;
    case 'decision':
      return `${p.verdict === 'accept' ? '接受' : '否定'} @${String(p.onEventId).slice(0, 10)}`;
    case 'fork':
      return `从 ${String(p.from).slice(0, 10)} 拉出分支`;
    default:
      return e.kind;
  }
}

export function getState(db: DB, selectedId?: string | null) {
  const allEvents = listEvents(db);
  const branches = (db.prepare('SELECT * FROM branches ORDER BY created_seq ASC').all() as {
    id: string; name: string; created_seq: number;
  }[]).map((b) => ({ ...b, headEventId: branchHead(db, b.id)?.id ?? null }));

  let selectedEvent: EventRow | null = null;
  if (selectedId) {
    selectedEvent = (db.prepare('SELECT * FROM events WHERE id = ?').get(selectedId) as unknown as EventRow | undefined) ?? null;
  }
  if (!selectedEvent) {
    const main = branches.find((b) => b.name === 'main') ?? branches[0];
    selectedEvent = main ? branchHead(db, main.id) : null;
  }

  const chain = selectedEvent ? walkChain(db, selectedEvent.id) : [];
  let materialsId: string | null = null;
  let parameterSetId: string | null = null;
  let computeEvent: EventRow | null = null;
  for (const e of chain) {
    if (!materialsId && (e.kind === 'import_source' || e.kind === 'edit_source')) {
      materialsId = (JSON.parse(e.payload) as { materialsId: string }).materialsId;
    }
    if (!parameterSetId && e.kind === 'revise_parameters') {
      parameterSetId = (JSON.parse(e.payload) as { parameterSetId: string }).parameterSetId;
    }
    if (!computeEvent && e.kind === 'compute') computeEvent = e;
  }
  const defaultPsId = getMeta(db, 'defaultParameterSetId');
  const psId = parameterSetId ?? defaultPsId;

  let materials: ReturnType<typeof parseMaterials> | null = null;
  if (materialsId) {
    const row = db.prepare('SELECT source FROM materials WHERE id = ?').get(materialsId) as { source: string } | undefined;
    if (row) materials = parseMaterials(row.source);
  }
  const parameters = psId ? getParameters(db, psId) : { ...DEFAULT_PARAMS };

  const decisions: { id: string; seq: number; branchId: string; onEventId?: string; verdict?: string; rationale?: string }[] =
    allEvents
      .filter((e) => e.kind === 'decision')
      .map((e) => ({ id: e.id, seq: e.seq, branchId: e.branch_id, ...(JSON.parse(e.payload) as Record<string, unknown>) }));

  const selectedComputeId = computeEvent?.id ?? null;
  const targeting = decisions.filter((d) => d.onEventId === selectedComputeId);
  const conflicts = targeting.length > 1 && new Set(targeting.map((d) => d.verdict)).size > 1;

  return {
    case: {
      caseId: getMeta(db, 'seeded'),
      title: getMeta(db, 'caseTitle'),
      units: (() => {
        try { return JSON.parse(getMeta(db, 'caseUnits') ?? '{}') as Record<string, string>; } catch { return {}; }
      })(),
    },
    branches,
    events: allEvents.map((e) => {
      const payload = JSON.parse(e.payload) as Record<string, unknown>;
      return {
        id: e.id,
        seq: e.seq,
        branchId: e.branch_id,
        parentId: e.parent_id,
        kind: e.kind,
        summary: eventSummary(e),
        paramVersion: e.param_version,
        inputDigest: e.input_digest,
        status: e.kind === 'compute' ? (payload.status as string) : null,
        verdict: e.kind === 'decision' ? (payload.verdict as string) : null,
        hasResult: Boolean(e.result),
      };
    }),
    selected: {
      event: selectedEvent ? {
        id: selectedEvent.id,
        seq: selectedEvent.seq,
        branchId: selectedEvent.branch_id,
        parentId: selectedEvent.parent_id,
        kind: selectedEvent.kind,
        summary: eventSummary(selectedEvent),
        paramVersion: selectedEvent.param_version,
        inputDigest: selectedEvent.input_digest,
        payload: JSON.parse(selectedEvent.payload),
        ancestry: chain.map((e) => e.id),
      } : null,
      materials: materials && materials.ok
        ? {
            id: materials.materials.id,
            digest: materials.materials.digest,
            source: materials.materials.source,
            classes: materials.materials.classes,
            precolors: materials.materials.precolors,
            blocks: materials.materials.blocks,
            edges: materials.materials.edges,
            moves: materials.materials.moves,
            instructions: materials.materials.instructions,
            diagnostics: materials.materials.diagnostics,
          }
        : materials && !materials.ok
          ? { id: materialsId, parseFailure: materials.diagnostics }
          : null,
      parameters,
      parameterSetId: psId,
      result: computeEvent?.result ? (JSON.parse(computeEvent.result) as PipelineResult) : null,
      resultEventId: computeEvent?.id ?? null,
      decisions: targeting,
      conflicts,
    },
  };
}

export type AppState = ReturnType<typeof getState>;

// ---------- export / import ----------

export interface Bundle {
  formatVersion: 1;
  caseId: string;
  exportedAt: string;
  meta: Record<string, string>;
  materials: { id: string; source: string; digest: string; created_seq: number }[];
  parameterSets: { id: string; version: number; payload: string; parent_id: string | null; created_seq: number }[];
  branches: { id: string; name: string; created_seq: number }[];
  events: {
    id: string; branch_id: string; parent_id: string | null; seq: number;
    kind: string; payload: string; input_digest: string; param_version: number; result: string | null;
  }[];
}

export function exportBundle(db: DB): Bundle {
  const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
  const metaRows = rows<{ key: string; value: string }>('SELECT key, value FROM meta');
  const meta: Record<string, string> = {};
  for (const r of metaRows) meta[r.key] = r.value;
  return {
    formatVersion: 1,
    caseId: meta.seeded ?? '',
    exportedAt: new Date(0).toISOString(),
    meta,
    materials: rows('SELECT id, source, digest, created_seq FROM materials ORDER BY created_seq ASC'),
    parameterSets: rows('SELECT id, version, payload, parent_id, created_seq FROM parameter_sets ORDER BY created_seq ASC'),
    branches: rows('SELECT id, name, created_seq FROM branches ORDER BY created_seq ASC'),
    events: rows('SELECT id, branch_id, parent_id, seq, kind, payload, input_digest, param_version, result FROM events ORDER BY seq ASC'),
  };
}

function validateBundle(bundle: unknown): bundle is Bundle {
  if (typeof bundle !== 'object' || bundle === null) return false;
  const b = bundle as Partial<Bundle>;
  if (b.formatVersion !== 1) return false;
  for (const key of ['materials', 'parameterSets', 'branches', 'events'] as const) {
    if (!Array.isArray(b[key])) return false;
  }
  return true;
}

export function importBundle(db: DB, raw: unknown): { ok: true; imported: { materials: number; events: number; branches: number }; skipped: number } | Failure {
  if (!validateBundle(raw)) {
    return { ok: false, status: 'format_corrupt', message: '导出包格式损坏：缺少 formatVersion=1 或必需表数组' };
  }
  const bundle = raw;

  const branchIds = new Set((db.prepare('SELECT id FROM branches').all() as { id: string }[]).map((r) => r.id));
  for (const b of bundle.branches) {
    if (typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.created_seq !== 'number') {
      return { ok: false, status: 'format_corrupt', message: 'branches 行结构损坏，导入中止（无半写）' };
    }
    branchIds.add(b.id);
  }
  const eventIds = new Set((db.prepare('SELECT id FROM events').all() as { id: string }[]).map((r) => r.id));
  for (const e of bundle.events) eventIds.add(e.id);
  for (const e of bundle.events) {
    if (typeof e.id !== 'string' || typeof e.branch_id !== 'string' || typeof e.seq !== 'number') {
      return { ok: false, status: 'format_corrupt', message: 'events 行结构损坏，导入中止（无半写）' };
    }
    if (!branchIds.has(e.branch_id)) {
      return { ok: false, status: 'format_corrupt', message: `事件 ${e.id} 引用不存在的分支 ${e.branch_id}，导入中止（无半写）` };
    }
    if (e.parent_id && !eventIds.has(e.parent_id)) {
      return { ok: false, status: 'format_corrupt', message: `事件 ${e.id} 的父事件 ${e.parent_id} 缺失，导入中止（无半写）` };
    }
  }

  let imported = { materials: 0, events: 0, branches: 0 };
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(bundle.meta ?? {})) {
      setMeta(db, key, value);
    }
    for (const m of bundle.materials) {
      const r = db.prepare('INSERT OR IGNORE INTO materials(id, source, digest, created_seq) VALUES(?, ?, ?, ?)')
        .run(m.id, m.source, m.digest, m.created_seq);
      r.changes > 0 ? (imported.materials += 1) : (skipped += 1);
    }
    for (const p of bundle.parameterSets) {
      db.prepare('INSERT OR IGNORE INTO parameter_sets(id, version, payload, parent_id, created_seq) VALUES(?, ?, ?, ?, ?)')
        .run(p.id, p.version, p.payload, p.parent_id, p.created_seq);
    }
    for (const b of bundle.branches) {
      const r = db.prepare('INSERT OR IGNORE INTO branches(id, name, created_seq) VALUES(?, ?, ?)')
        .run(b.id, b.name, b.created_seq);
      if (r.changes > 0) imported.branches += 1;
    }
    for (const e of bundle.events) {
      const r = db.prepare(
        `INSERT OR IGNORE INTO events(id, branch_id, parent_id, seq, kind, payload, input_digest, param_version, result)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.id, e.branch_id, e.parent_id, e.seq, e.kind, e.payload, e.input_digest, e.param_version, e.result);
      if (r.changes > 0) imported.events += 1;
      const maxSeq = parseInt(getMeta(db, 'seq') ?? '0', 10);
      if (e.seq > maxSeq) setMeta(db, 'seq', String(e.seq));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, status: 'format_corrupt', message: `导入中途失败，已回滚（半写恢复）: ${String(err)}` };
  }
  return { ok: true, imported, skipped };
}

// ---------- case seeding ----------

export function seedCasePackage(db: DB, pkg: CasePackage, opts: { force?: boolean } = {}): void {
  if (!opts.force && getMeta(db, 'seeded') === pkg.caseId) return;
  if (opts.force) {
    db.exec('DELETE FROM events; DELETE FROM branches; DELETE FROM materials; DELETE FROM parameter_sets; DELETE FROM meta;');
  }

  const ps = upsertParameterSet(db, null, pkg.parameters);
  setMeta(db, 'defaultParameterSetId', ps.id);
  setMeta(db, 'seeded', pkg.caseId);
  setMeta(db, 'caseTitle', pkg.title);
  setMeta(db, 'caseUnits', JSON.stringify(pkg.units ?? {}));

  const refs = new Map<string, string>();
  const branchIds = new Map<string, string>();
  const branch = (name: string) => {
    if (!branchIds.has(name)) branchIds.set(name, createBranch(db, name));
    return branchIds.get(name)!;
  };

  for (const op of pkg.script) {
    const bid = branch(op.branch ?? 'main');
    switch (op.op) {
      case 'import':
      case 'edit_source': {
        const source = pkg.sources[op.source ?? ''];
        const r = importSource(db, bid, source);
        if (!r.ok) throw new Error(`seed ${op.op} 失败: ${r.message ?? r.status}`);
        break;
      }
      case 'revise_parameters': {
        const r = reviseParameters(db, bid, op.patch ?? {});
        if (!r.ok) throw new Error(`seed revise_parameters 失败: ${r.message ?? r.status}`);
        break;
      }
      case 'compute': {
        const r = compute(db, bid);
        if (!r.ok) throw new Error(`seed compute 失败: ${r.message ?? r.status}`);
        if (op.as) refs.set(op.as, r.eventId);
        break;
      }
      case 'decide': {
        const target = refs.get(op.on ?? '');
        if (!target) throw new Error(`seed decide 缺少引用 ${op.on}`);
        decide(db, bid, target, op.verdict === 'reject' ? 'reject' : 'accept', op.rationale ?? '');
        break;
      }
      case 'fork': {
        const from = refs.get(op.from ?? '');
        if (!from) throw new Error(`seed fork 缺少引用 ${op.from}`);
        const head = branchHead(db, bid);
        const payload = { from };
        appendEvent(db, {
          branchId: bid,
          parentId: from,
          kind: 'fork',
          payload,
          inputDigest: 'fork',
          paramVersion: resolveContext(db, bid, from).paramVersion,
        });
        void head;
        break;
      }
      default:
        throw new Error(`seed 未知操作 ${op.op}`);
    }
  }
}
