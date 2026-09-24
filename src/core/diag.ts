import type { Diagnostic } from '../shared/types.js';

export function diag(
  code: Diagnostic['code'],
  message: string,
  position: Diagnostic['position'] = null,
  offendingRaw?: string,
): Diagnostic {
  return { code, message, position, offendingRaw };
}

/** 输入不完整 / 无法转换：不得用空值或默认值伪装成功 */
export class DiagnosticError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `[${d.code}] ${d.message}`).join('; '));
    this.diagnostics = diagnostics;
  }
}

export function isFatalInput(d: Diagnostic): boolean {
  return d.code === 'INCOMPLETE_INPUT' || d.code === 'MALFORMED_FORMAT';
}
