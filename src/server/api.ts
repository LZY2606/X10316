import type { Connect, Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { Store } from './store';
import { seedCasePack } from './casepack';
import { runPipeline } from '../core/pipeline';
import { parseProgram } from '../core/parse';
import { stableId } from '../core/digest';
import type { Params, Program } from '../core/types';

// 服务端业务规则：全部领域计算在 Node 侧完成，存储层可直接被测试调用。

export const DB_PATH = process.env.REVIEW_DB ?? 'data/review.db';

let store: Store | null = null;

export function getStore(): Store {
  if (!store) {
    const fresh = !existsSync(DB_PATH);
    store = new Store(DB_PATH);
    if (fresh || store.listMaterials().length === 0) seedCasePack(store);
  }
  return store;
}

export function resetStore(s?: Store): Store {
  store?.close();
  store = s ?? null;
  return getStore();
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

export function createApiHandler(): Connect.NextHandleFunction {
  const s = () => getStore();
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const go = async () => {
      // 状态总览
      if (method === 'GET' && path === '/api/state') {
        const st = s();
        return send(res, 200, {
          branches: st.listBranches(),
          materials: st.listMaterials().map((m) => ({ id: m.id, kind: m.kind, version: m.version, digest: m.digest, parent_id: m.parent_id })),
          decisions: st.listDecisions().map((d) => ({ ...d })),
          events: st.listEvents().map((e) => ({ id: e.id, seq: e.seq, branch: e.branch, type: e.type, input_digest: e.input_digest, param_version: e.param_version, parents: JSON.parse(e.parents), created_at: e.created_at })),
        });
      }
      // 材料读回（每个显示值都带稳定身份）
      const matMatch = path.match(/^\/api\/material\/(.+)$/);
      if (method === 'GET' && matMatch) {
        const m = s().getMaterial(decodeURIComponent(matMatch[1]));
        return m ? send(res, 200, m) : send(res, 404, { error: 'material not found' });
      }
      const evMatch = path.match(/^\/api\/event\/(.+)$/);
      if (method === 'GET' && evMatch) {
        const e = s().getEvent(decodeURIComponent(evMatch[1]));
        return e ? send(res, 200, { ...e, parents: JSON.parse(e.parents), payload: JSON.parse(e.payload) }) : send(res, 404, { error: 'event not found' });
      }
      // 运行管线（服务端执行，可测试）
      if (method === 'POST' && path === '/api/run') {
        const body = JSON.parse(await readBody(req));
        const st = s();
        const progMat = st.getMaterial(body.programId);
        if (!progMat) return send(res, 404, { status: 'diagnostics', diagnostics: [{ severity: 'error', code: 'unknown-material', message: `材料不存在: ${body.programId}`, location: 'body.programId' }] });
        const program = (JSON.parse(progMat.content) as { program: Program }).program;
        const params: Params = body.params ?? { kind: 'params', paramVersion: 1, loopWeightBase: 10, maxIterations: 8, simplifyBudget: 100000, coalescing: true };
        const branch = body.branch ?? 'main';
        const result = runPipeline(program, params, [progMat.id]);
        let seq = st.nextSeq('events');
        for (const ev of result.events) {
          st.putEvent({ id: ev.id, seq: seq++, branch, type: ev.type, input_digest: ev.inputDigest, param_version: ev.paramVersion, parents: JSON.stringify(ev.parents), payload: JSON.stringify(ev.payload), created_at: new Date().toISOString() });
        }
        const runId = stableId('run', { digest: result.inputDigest, at: Date.now() });
        st.putMaterial({ id: runId, kind: 'run', version: 1, content: JSON.stringify({ label: body.label ?? 'manual run', status: result.status, diagnostics: result.diagnostics, view: result.view ?? null, inputDigest: result.inputDigest, paramVersion: result.paramVersion, programId: progMat.id }), digest: result.inputDigest, parent_id: progMat.id, created_event: result.events.at(-1)?.id ?? null });
        return send(res, 200, { ...result, runId });
      }
      // 决定：接受 / 否定 / 参数调整都生成新事件式记录
      if (method === 'POST' && path === '/api/decision') {
        const body = JSON.parse(await readBody(req));
        const st = s();
        const id = stableId('dec', { ...body, at: Date.now() });
        st.putDecision({ id, seq: st.nextSeq('decisions'), branch: body.branch ?? 'main', target: body.target, action: body.action, status: 'recorded', payload: JSON.stringify(body.payload ?? {}), rationale: body.rationale ?? '', created_at: new Date().toISOString() });
        return send(res, 200, { id });
      }
      const decStatus = path.match(/^\/api\/decision\/(.+)\/status$/);
      if (method === 'POST' && decStatus) {
        const body = JSON.parse(await readBody(req));
        s().setDecisionStatus(decodeURIComponent(decStatus[1]), body.status);
        return send(res, 200, { ok: true });
      }
      // 回到旧事件：恢复当时的依赖版本与可见结论（不覆盖历史）
      if (method === 'POST' && path === '/api/restore') {
        const body = JSON.parse(await readBody(req));
        const st = s();
        const br = st.getBranch(body.branch);
        if (!br) return send(res, 404, { error: 'branch not found' });
        st.putBranch({ ...br, head_event: body.eventId });
        return send(res, 200, { ok: true, head_event: body.eventId });
      }
      // 导出 / 导入 / 重置
      if (method === 'GET' && path === '/api/export') {
        return send(res, 200, s().exportAll(), { 'content-disposition': 'attachment; filename="regalloc-review-export.json"' });
      }
      if (method === 'POST' && path === '/api/import') {
        const text = await readBody(req);
        const result = s().importAll(text);
        return send(res, result.status === 'ok' ? 200 : 422, result);
      }
      if (method === 'POST' && path === '/api/reset') {
        const st = s();
        st.db.exec('DELETE FROM decisions; DELETE FROM events; DELETE FROM materials; DELETE FROM branches;');
        const summary = seedCasePack(st);
        return send(res, 200, summary);
      }
      if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
      return next();
    };
    go().catch((e) => send(res, 500, { error: String(e?.message ?? e) }));
  };
}

export function apiPlugin(): Plugin {
  return {
    name: 'regalloc-review-api',
    configureServer(server) {
      getStore(); // 启动即种子化案例包
      server.middlewares.use('/api', createApiHandler());
    },
  };
}
