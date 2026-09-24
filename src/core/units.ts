/**
 * Quantities with explicit unit / coordinate basis.
 * Raw imported values are preserved; normalization is a derived-layer step.
 * Values that cannot be converted stay in place and get a diagnostic.
 */
import type { Diagnostic } from "./ir.js";

export interface Quantity {
  value: number;
  /** e.g. "ref-weight", "instr-index", "phys-reg-count" */
  unit: string;
  /** coordinate basis, e.g. "weightBase^loopDepth", "block+index" */
  basis: string;
}

export interface ProgramPoint {
  block: string;
  index: number;
}

export const q = (value: number, unit: string, basis: string): Quantity => ({ value, unit, basis });

export function blockWeight(loopDepth: number, weightBase: number): Quantity {
  return q(Math.pow(weightBase, loopDepth), "ref-weight", `${weightBase}^loopDepth`);
}

export interface NormalizeResult {
  value?: number;
  diagnostic?: Diagnostic;
}

/** Derived-layer normalization. Never invents a value it cannot derive. */
export function normalizeWeight(raw: unknown, weightBase: number, pos: Diagnostic["pos"]): NormalizeResult {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return { value: Number(raw) };
  }
  return {
    diagnostic: {
      code: "unconvertible-weight",
      severity: "error",
      pos,
      message: `weight value ${JSON.stringify(raw)} cannot be converted to ref-weight (basis ${weightBase}^loopDepth); left in place`,
    },
  };
}
