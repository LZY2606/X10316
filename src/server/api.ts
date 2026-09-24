import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createStore, type DB } from './db.js';
import {
  compute,
  decide,
  exportBundle,
  getState,
  importBundle,
  importSource,
  reviseParameters,
  seedCasePackage,
  type CasePackage,
} from './service.js';
import casePackage from './case/register-conflict-spectrum.case.json';

const pkg = casePackage as unknown as CasePackage;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function handleApi(db: DB, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/state') {
    send(res, 200, { ok: true, state: getState(db, url.searchParams.get('eventId')) });
    return;
  }

  if (method === 'POST' && path === '/import') {
    readBody(req)
      .then((b) => {
        const { branchId, source } = b as { branchId: string; source: string };
        if (typeof source !== 'string') {
          send(res, 400, { ok: false, status: 'format_corrupt', message: '缺少 source 文本' });
          return;
        }
        const r = importSource(db, branchId, source);
        send(res, 'ok' in r ? 200 : 422, r);
      })
      .catch((e) => send(res, 400, { ok: false, status: 'format_corrupt', message: String(e) }));
    return;
  }

  if (method === 'POST' && path === '/param') {
    readBody(req).then((b) => {
      const { branchId, patch } = b as { branchId: string; patch: Parameters<typeof reviseParameters>[2] };
      const r = reviseParameters(db, branchId, patch);
      send(res, 'ok' in r ? 200 : 422, r);
    }).catch((e) => send(res, 400, { ok: false, status: 'format_corrupt', message: String(e) }));
    return;
  }

  if (method === 'POST' && path === '/compute') {
    readBody(req).then((b) => {
      const { branchId } = b as { branchId: string };
      const r = compute(db, branchId);
      send(res, 'ok' in r ? 200 : 422, r);
    }).catch((e) => send(res, 400, { ok: false, status: 'format_corrupt', message: String(e) }));
    return;
  }

  if (method === 'POST' && path === '/decide') {
    readBody(req).then((b) => {
      const { branchId, onEventId, verdict, rationale } = b as {
        branchId: string; onEventId: string; verdict: 'accept' | 'reject'; rationale: string;
      };
      const r = decide(db, branchId, onEventId, verdict, rationale ?? '');
      send(res, 'ok' in r ? 200 : 422, r);
    }).catch((e) => send(res, 400, { ok: false, status: 'format_corrupt', message: String(e) }));
    return;
  }

  if (method === 'GET' && path === '/export') {
    send(res, 200, exportBundle(db));
    return;
  }

  if (method === 'POST' && path === '/import-bundle') {
    readBody(req).then((bundle) => {
      const r = importBundle(db, bundle);
      send(res, 'ok' in r ? 200 : 422, r);
    }).catch((e) => send(res, 400, { ok: false, status: 'format_corrupt', message: `包解析失败: ${String(e)}` }));
    return;
  }

  if (method === 'POST' && path === '/reset') {
    seedCasePackage(db, pkg, { force: true });
    send(res, 200, { ok: true, state: getState(db, null) });
    return;
  }

  send(res, 404, { ok: false, message: `unknown api route ${method} ${path}` });
}

export function apiPlugin(dbPath = 'data/app.db'): Plugin {
  return {
    name: 'register-conflict-spectrum-api',
    configureServer(server) {
      const db = createStore(dbPath);
      seedCasePackage(db, pkg);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api')) {
          next();
          return;
        }
        try {
          handleApi(db, req, res);
        } catch (err) {
          send(res, 500, { ok: false, message: String(err) });
        }
      });
    },
  };
}
