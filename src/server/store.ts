import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 存储层：不可变材料（materials）与可修改决定（decisions）分层；
// 所有计算结果（events/runs）记录输入摘要、参数版本、父级依赖。
// 导出/导入保持身份、顺序（seq）与来源关系（parents）。

export interface MaterialRow {
  id: string; kind: string; version: number;
  content: string; digest: string; parent_id: string | null; created_event: string | null;
}
export interface EventRow {
  id: string; seq: number; branch: string; type: string;
  input_digest: string; param_version: number; parents: string; payload: string; created_at: string;
}
export interface DecisionRow {
  id: string; seq: number; branch: string; target: string; action: string;
  status: string; payload: string; rationale: string; created_at: string;
}
export interface BranchRow { id: string; name: string; head_event: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL, digest TEXT NOT NULL,
  parent_id TEXT, created_event TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, branch TEXT NOT NULL, type TEXT NOT NULL,
  input_digest TEXT NOT NULL, param_version INTEGER NOT NULL,
  parents TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, branch TEXT NOT NULL,
  target TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
  payload TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT NOT NULL, head_event TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch, seq);
CREATE INDEX IF NOT EXISTS idx_decisions_branch ON decisions(branch, seq);
`;

export const EXPORT_FORMAT = 'regalloc-review-export';
export const EXPORT_VERSION = 1;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  // ---------- 材料层（不可变：只新增版本，不原地修改） ----------
  putMaterial(m: MaterialRow): void {
    this.db.prepare('INSERT OR IGNORE INTO materials (id,kind,version,content,digest,parent_id,created_event) VALUES (?,?,?,?,?,?,?)')
      .run(m.id, m.kind, m.version, m.content, m.digest, m.parent_id, m.created_event);
  }
  getMaterial(id: string): MaterialRow | undefined {
    return this.db.prepare('SELECT * FROM materials WHERE id=?').get(id) as unknown as MaterialRow | undefined;
  }
  listMaterials(kind?: string): MaterialRow[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM materials WHERE kind=? ORDER BY version, id').all(kind)
      : this.db.prepare('SELECT * FROM materials ORDER BY kind, version, id').all()) as unknown as MaterialRow[];
    return rows;
  }

  // ---------- 事件层（机器可读，顺序由 seq 保证） ----------
  nextSeq(table: 'events' | 'decisions'): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM ${table}`).get() as unknown as { s: number };
    return row.s;
  }
  putEvent(e: EventRow): void {
    this.db.prepare('INSERT OR IGNORE INTO events (id,seq,branch,type,input_digest,param_version,parents,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(e.id, e.seq, e.branch, e.type, e.input_digest, e.param_version, e.parents, e.payload, e.created_at);
  }
  listEvents(branch?: string): EventRow[] {
    return (branch
      ? this.db.prepare('SELECT * FROM events WHERE branch=? ORDER BY seq').all(branch)
      : this.db.prepare('SELECT * FROM events ORDER BY seq').all()) as unknown as EventRow[];
  }
  getEvent(id: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as unknown as EventRow | undefined;
  }

  // ---------- 决定层（可修改：接受/否定/调整都生成新记录，历史保留） ----------
  putDecision(d: DecisionRow): void {
    this.db.prepare('INSERT OR IGNORE INTO decisions (id,seq,branch,target,action,status,payload,rationale,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(d.id, d.seq, d.branch, d.target, d.action, d.status, d.payload, d.rationale, d.created_at);
  }
  listDecisions(branch?: string): DecisionRow[] {
    return (branch
      ? this.db.prepare('SELECT * FROM decisions WHERE branch=? ORDER BY seq').all(branch)
      : this.db.prepare('SELECT * FROM decisions ORDER BY seq').all()) as unknown as DecisionRow[];
  }
  setDecisionStatus(id: string, status: string): void {
    this.db.prepare('UPDATE decisions SET status=? WHERE id=?').run(status, id);
  }

  // ---------- 分支 ----------
  putBranch(b: BranchRow): void {
    this.db.prepare('INSERT INTO branches (id,name,head_event) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET head_event=excluded.head_event')
      .run(b.id, b.name, b.head_event);
  }
  listBranches(): BranchRow[] {
    return this.db.prepare('SELECT * FROM branches ORDER BY id').all() as unknown as BranchRow[];
  }
  getBranch(id: string): BranchRow | undefined {
    return this.db.prepare('SELECT * FROM branches WHERE id=?').get(id) as unknown as BranchRow | undefined;
  }

  // ---------- 导出 / 导入（往返保持身份、顺序、来源关系） ----------
  exportAll(): string {
    return JSON.stringify({
      format: EXPORT_FORMAT, version: EXPORT_VERSION,
      tables: {
        materials: this.db.prepare('SELECT * FROM materials ORDER BY id').all(),
        events: this.db.prepare('SELECT * FROM events ORDER BY seq').all(),
        decisions: this.db.prepare('SELECT * FROM decisions ORDER BY seq').all(),
        branches: this.db.prepare('SELECT * FROM branches ORDER BY id').all(),
      },
    }, null, 2);
  }

  // 返回判别联合：格式损坏是独立结果；导入在单事务内完成（半写恢复）。
  importAll(text: string): { status: 'ok' } | { status: 'format_corrupt'; diagnostics: { code: string; message: string; location?: string }[] } {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      return { status: 'format_corrupt', diagnostics: [{ code: 'bad-json', message: `导出文件不是合法 JSON: ${(e as Error).message}`, location: '<file>' }] };
    }
    const doc = parsed as { format?: string; version?: number; tables?: Record<string, unknown[]> };
    if (doc?.format !== EXPORT_FORMAT || typeof doc.version !== 'number' || !doc.tables) {
      return { status: 'format_corrupt', diagnostics: [{ code: 'bad-envelope', message: '导出文件缺少 format/version/tables 信封', location: '<root>' }] };
    }
    const need: [string, string[]][] = [
      ['materials', ['id', 'kind', 'version', 'content', 'digest']],
      ['events', ['id', 'seq', 'branch', 'type', 'input_digest', 'param_version', 'parents', 'payload', 'created_at']],
      ['decisions', ['id', 'seq', 'branch', 'target', 'action', 'status', 'payload', 'rationale', 'created_at']],
      ['branches', ['id', 'name']],
    ];
    for (const [table, cols] of need) {
      const rows = doc.tables[table];
      if (!Array.isArray(rows)) return { status: 'format_corrupt', diagnostics: [{ code: 'missing-table', message: `缺少表 ${table}`, location: `tables.${table}` }] };
      for (let i = 0; i < rows.length; i++) {
        for (const c of cols) {
          if (!(c in (rows[i] as Record<string, unknown>))) {
            return { status: 'format_corrupt', diagnostics: [{ code: 'missing-column', message: `行缺少列 ${c}`, location: `tables.${table}[${i}]` }] };
          }
        }
      }
    }
    // 单事务替换：任何一步失败都整体回滚（半写恢复）
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM decisions; DELETE FROM events; DELETE FROM materials; DELETE FROM branches;');
      for (const m of doc.tables.materials as unknown as MaterialRow[]) this.putMaterial(m);
      for (const e of doc.tables.events as unknown as EventRow[]) this.putEvent(e);
      for (const d of doc.tables.decisions as unknown as DecisionRow[]) this.putDecision(d);
      for (const b of doc.tables.branches as unknown as BranchRow[]) {
        this.db.prepare('INSERT INTO branches (id,name,head_event) VALUES (?,?,?)').run(b.id, b.name, b.head_event ?? null);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      return { status: 'format_corrupt', diagnostics: [{ code: 'import-failed', message: `导入事务回滚: ${(e as Error).message}` }] };
    }
    return { status: 'ok' };
  }
}
