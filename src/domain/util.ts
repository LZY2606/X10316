import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedStrings(set: Iterable<string>): string[] {
  return [...set].sort(cmpStr);
}
