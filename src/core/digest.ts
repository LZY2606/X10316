import { createHash } from 'node:crypto';

// 稳定身份：canonical JSON（键排序）+ sha256。
// 等价输入必须得到稳定顺序与稳定摘要。
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
    return out;
  }
  return v;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 16);
}

let counter = 0;
// 事件/材料身份：由内容摘要 + 单调序号构成，进程内稳定且可重放。
export function stableId(prefix: string, content: unknown): string {
  counter += 1;
  return `${prefix}-${digest(content)}-${String(counter).padStart(4, '0')}`;
}

export function resetIdCounter(seq: number): void {
  counter = seq;
}
