import type { Diagnostic, Quantity } from './types';

// 单位与坐标基准：导入时保留原始表示，派生层才做规范化。
// 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。

const CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  'exec-frequency': {
    'kexec-frequency': (v) => v * 1000,
  },
  'spill-cost': {
    'kspill-cost': (v) => v * 1000,
  },
};

export interface Normalized<T> {
  value: T;
  diagnostics: Diagnostic[];
}

// 把 quantity 规范化到目标单位；无法转换时原样返回并附诊断。
export function normalizeQuantity(q: Quantity, targetUnit: string, location: string): Normalized<Quantity> {
  if (q.unit === targetUnit) return { value: q, diagnostics: [] };
  const conv = CONVERSIONS[targetUnit]?.[q.unit];
  if (conv) {
    return { value: { ...q, value: conv(q.value), unit: targetUnit }, diagnostics: [] };
  }
  return {
    value: q, // 原始表示留在原位置
    diagnostics: [{
      severity: 'warning',
      code: 'unconvertible-unit',
      message: `无法把单位 "${q.unit}" 转换为 "${targetUnit}"，保留原始表示`,
      location,
    }],
  };
}

export function fmtQuantity(q: Quantity): string {
  return `${q.value} ${q.unit}${q.basis ? ` @ ${q.basis}` : ''}`;
}
