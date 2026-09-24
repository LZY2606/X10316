import type { Diagnostic, Quantity } from './types';

const UNIT_ALIASES: Record<string, string> = {
  '': 'none',
  cycle: 'cycle',
  cycles: 'cycle',
  'cycle/iter': 'cycle/iter',
  slot: 'slot',
  slots: 'slot',
};

// Raw representation is always preserved; normalization happens only here in
// the derived layer. Values that cannot be converted stay in place with a
// diagnostic attached instead of being dropped.
export function parseQuantity(raw: unknown, position: string): Quantity {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);
  if (!m) {
    return {
      raw: s,
      value: null,
      unit: null,
      basis: null,
      diagnostic: {
        position,
        severity: 'warning',
        message: `quantity ${JSON.stringify(s)} cannot be normalized; kept in raw form`,
      },
    };
  }
  const unitRaw = m[2] ?? '';
  const unit = UNIT_ALIASES[unitRaw];
  if (unitRaw !== '' && unit === undefined) {
    return {
      raw: s,
      value: Number.parseFloat(m[1]!),
      unit: null,
      basis: null,
      diagnostic: {
        position,
        severity: 'warning',
        message: `unknown unit "${unitRaw}" at ${position}; numeric value kept, unit unresolved`,
      },
    };
  }
  return { raw: s, value: Number.parseFloat(m[1]!), unit: unit ?? null, basis: null };
}

export function quantity(value: number, unit: string, basis: string): Quantity {
  return { raw: `${value} ${unit}`, value, unit, basis };
}

export function quantityDiagnostics(q: Quantity | null): Diagnostic[] {
  return q && q.diagnostic ? [q.diagnostic] : [];
}
