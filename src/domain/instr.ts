import type { Instruction } from './types.js';

export function instrToText(i: Instruction): string {
  if (i.op === 'phi') {
    return `instr ${i.id} @${i.block} phi ${i.defs[0].name}:${i.defs[0].cls} = [${i.phiUses
      .map((p) => `${p.pred}:${p.name}`)
      .join(', ')}]`;
  }
  if (i.op === 'move') {
    return `instr ${i.id} @${i.block} move ${i.defs[0].name}:${i.defs[0].cls} <- ${i.uses[0].name}:${i.uses[0].cls}`;
  }
  if (i.op === 'call') {
    return `instr ${i.id} @${i.block} call clobber ${i.clobbers.join(' ')}`;
  }
  if (i.op === 'br') {
    const targets = (i as unknown as { targets?: string[] }).targets ?? [];
    return `instr ${i.id} @${i.block} br ${i.uses[0]?.name ?? ''} -> ${targets.join(' ')}`;
  }
  if (i.op === 'ret') return `instr ${i.id} @${i.block} ret ${i.uses[0]?.name ?? ''}`;
  const parts = [`instr ${i.id} @${i.block}`];
  if (i.defs.length) parts.push('def ' + i.defs.map((d) => `${d.name}:${d.cls}`).join(' '));
  if (i.uses.length) parts.push('use ' + i.uses.map((u) => u.name).join(' '));
  parts.push('op ' + i.op);
  return parts.join(' ');
}

export function cloneInstrs(instrs: Instruction[]): Instruction[] {
  return instrs.map((i) => ({
    ...i,
    defs: i.defs.map((d) => ({ ...d })),
    uses: i.uses.map((u) => ({ ...u })),
    phiUses: i.phiUses.map((p) => ({ ...p })),
    move: i.move ? { ...i.move } : null,
    clobbers: [...i.clobbers],
  }));
}
