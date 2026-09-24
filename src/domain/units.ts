import type { Quantity } from './types.js';

export const KNOWN_UNITS = ['exec', 'cycle'];

/** 解析领域量，保留原始表示；无法转换的值留在原位置并附诊断。 */
export function parseQuantity(raw: string): Quantity {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/);
  if (!m) {
    return { raw, value: null, unit: null, diagnostic: `无法解析的数量表示: ${raw}` };
  }
  const unit = m[2] ?? null;
  const q: Quantity = { raw, value: parseFloat(m[1]), unit };
  if (!unit) {
    q.diagnostic = `数量缺少单位或坐标基准: ${raw}`;
  } else if (!KNOWN_UNITS.includes(unit)) {
    q.diagnostic = `未知单位 "${unit}"，保留原始表示，派生计算标记为不可转换`;
  }
  return q;
}

/** 派生层规范化：循环权重 -> 代价因子。不可转换时返回 null，绝不静默取默认值。 */
export function weightFactor(q: Quantity, loopExponent: number): number | null {
  if (q.diagnostic || q.value === null || q.unit !== 'exec') return null;
  return Math.pow(q.value, loopExponent);
}
