import { createHash } from 'node:crypto';

/** 稳定内容寻址：同内容（等价输入）得到同 id；导出/删除/导入后身份保持 */
export function sha256Short(payload: unknown, prefix = ''): string {
  const text =
    typeof payload === 'string' ? payload : stableStringify(payload);
  const h = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return prefix ? `${prefix}_${h}` : h;
}

/** 键序确定的序列化：等价输入得到稳定顺序/哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set([...values])].sort();
}

/** 确定性 tie-break：先按主键数值，再按名字，保证可回放 */
export function deterministicCompare(
  a: string,
  b: string,
  primary?: Record<string, number>,
): number {
  if (primary) {
    const da = primary[a] ?? 0;
    const db = primary[b] ?? 0;
    if (da !== db) return da - db;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
