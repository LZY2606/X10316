import type { Diagnostic, DiagnosticCode, TextPos } from "./types.js";

export function diag(
  code: DiagnosticCode,
  message: string,
  pos?: TextPos,
  fragment?: string
): Diagnostic {
  return { code, message, pos, fragment, fatal: true };
}

export function isFatal(ds: Diagnostic[]): boolean {
  return ds.some((d) => d.fatal);
}

export class DiagnosticError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));
  }
}
