import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortDigest(value: unknown): string {
  return digest(value).slice(0, 12);
}
