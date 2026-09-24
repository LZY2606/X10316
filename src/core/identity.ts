// Stable identities and ordering. Deterministic across machines/runs:
// we hash canonical JSON with a small in-file FNV/sha implementation and
// never rely on insertion order or wall-clock time.
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${contentHash(value)}`;
}

/** Canonical pair id, order independent. */
export function pairId(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}
