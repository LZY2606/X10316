import type { Diagnostic } from "./types.js";

export function diag(
  code: string,
  message: string,
  at?: Partial<Pick<Diagnostic, "line" | "column" | "block" | "instruction" | "operand" | "category" | "rawValue">>,
  severity: "error" | "warning" = "error",
): Diagnostic {
  return { code, severity, message, ...at };
}

export const CODES = {
  FORMAT_PARSE: "E1001",
  FORMAT_MISSING: "E1002",
  SEMANTIC_UNKNOWN_CLASS: "E2001",
  SEMANTIC_UNKNOWN_PHYS: "E2002",
  SEMANTIC_UNKNOWN_BLOCK: "E2003",
  SEMANTIC_PHI_EDGE: "E2004",
  SEMANTIC_CROSS_CLASS_MOVE: "E2005",
  SEMANTIC_PRECOLOR_CONFLICT: "E2006",
  SEMANTIC_NO_COLOR: "E2007",
  BUDGET_SPILL_EXHAUSTED: "E3001",
} as const;
