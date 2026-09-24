// 客户端 API 封装
export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { body });
  return body as T;
}

export interface StateResp {
  branches: { id: string; name: string; head_event: string | null }[];
  materials: { id: string; kind: string; version: number; digest: string; parent_id: string | null }[];
  decisions: Decision[];
  events: EventMeta[];
}
export interface EventMeta {
  id: string; seq: number; branch: string; type: string;
  input_digest: string; param_version: number; parents: string[]; created_at: string;
}
export interface Decision {
  id: string; seq: number; branch: string; target: string; action: string;
  status: string; payload: string; rationale: string; created_at: string;
}
