import { createHash } from "node:crypto";

/** stable content digest for input summaries */
export function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

let counter = 0;
/** stable, unique, sortable id: <kind>:<seq16>:<hash> */
export function makeId(kind: string, seed: unknown): string {
  const n = (Date.now() * 1000 + (counter++ % 1000)).toString(36);
  return `${kind}:${n}:${digest(seed)}`;
}
