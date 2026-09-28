import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function shortHash(text: string): string {
  return sha256(text).slice(0, 12);
}

/** Deterministic record id: c<sha12>, d<n>, e<n> etc. */
export function compId(kind: string, summary: string, parents: string[]): string {
  return `c-${kind}-${shortHash(summary + "|" + parents.slice().sort().join(","))}`;
}

export function vregNum(ref: string): number {
  return Number(ref.startsWith("v") ? ref.slice(1) : ref);
}

/** Canonical virtual ordering: numeric vN order. */
export function sortVregs(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => vregNum(a) - vregNum(b) || (a < b ? -1 : a > b ? 1 : 0));
}
