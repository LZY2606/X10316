import type { Diagnostic, FunctionIR, Instr } from '../shared/types.js';

// Validates raw JSON into FunctionIR. Incomplete input -> positioned diagnostics,
// never silently defaulted.
export function validateFunction(raw: unknown): { ir?: FunctionIR; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string, pos: Diagnostic['pos'] = {}) =>
    diagnostics.push({ code, message, pos });

  if (typeof raw !== 'object' || raw === null) {
    fail('IR_NOT_OBJECT', 'function material must be an object');
    return { diagnostics };
  }
  const f = raw as Partial<FunctionIR>;
  if (typeof f.name !== 'string' || !f.name) fail('IR_NAME_MISSING', 'function name missing');
  if (!Array.isArray(f.regClasses) || f.regClasses.length === 0)
    fail('IR_REGCLASS_MISSING', 'register classes missing');
  if (typeof f.entry !== 'string' || !f.entry) fail('IR_ENTRY_MISSING', 'entry block id missing');
  if (!Array.isArray(f.blocks) || f.blocks.length === 0)
    fail('IR_BLOCKS_MISSING', 'CFG blocks missing');
  if (diagnostics.length) return { diagnostics };

  const ir = f as FunctionIR;
  const classNames = new Set(ir.regClasses.map((c) => c.name));
  const physOf = new Map<string, string>();
  for (const rc of ir.regClasses) {
    if (!Array.isArray(rc.physRegs) || rc.physRegs.length === 0)
      fail('IR_REGCLASS_EMPTY', `register class ${rc.name} has no phys regs`);
    for (const p of rc.physRegs ?? []) physOf.set(p, rc.name);
  }
  const blockIds = new Set(ir.blocks.map((b) => b.id));
  if (!blockIds.has(ir.entry)) fail('IR_ENTRY_UNKNOWN', `entry block ${ir.entry} not in CFG`);

  const preds = new Map<string, string[]>();
  for (const b of ir.blocks) {
    if (typeof b.loopDepth !== 'number')
      fail('IR_LOOPDEPTH_MISSING', `block ${b.id} missing loopDepth`, { block: b.id });
    if (!Array.isArray(b.succs)) fail('IR_SUCCS_MISSING', `block ${b.id} missing succs`, { block: b.id });
    for (const s of b.succs ?? []) {
      if (!blockIds.has(s)) fail('IR_SUCC_UNKNOWN', `block ${b.id} has unknown successor ${s}`, { block: b.id });
      else {
        const l = preds.get(s) ?? [];
        l.push(b.id);
        preds.set(s, l);
      }
    }
  }

  const checkOperand = (op: unknown, pos: Diagnostic['pos']) => {
    const o = op as { vreg?: unknown; class?: unknown };
    if (typeof o?.vreg !== 'string' || !o.vreg) fail('OPERAND_VREG_MISSING', 'operand missing vreg', pos);
    if (typeof o?.class !== 'string' || !classNames.has(o.class as string))
      fail('OPERAND_CLASS_UNKNOWN', `operand ${String(o?.vreg)} has unknown register class ${String(o?.class)}`, pos);
  };

  for (const b of ir.blocks) {
    if (!Array.isArray(b.instrs)) {
      fail('IR_INSTRS_MISSING', `block ${b.id} missing instrs`, { block: b.id });
      continue;
    }
    b.instrs.forEach((ins: Instr, i: number) => {
      const pos = { block: b.id, instr: ins?.id ?? `#${i}` };
      if (ins.kind === 'phi') {
        checkOperand(ins.def, pos);
        (ins.sources ?? []).forEach((s, j) => {
          const realPreds = preds.get(b.id) ?? [];
          if (!realPreds.includes(s.pred))
            fail('PHI_PRED_UNKNOWN', `phi ${ins.id} source #${j} names ${s.pred}, not a predecessor of ${b.id}`, { ...pos, operand: j });
          if (typeof s.vreg !== 'string' || !s.vreg)
            fail('PHI_SRC_MISSING', `phi ${ins.id} source #${j} missing vreg`, { ...pos, operand: j });
        });
        const realPreds = preds.get(b.id) ?? [];
        for (const p of realPreds)
          if (!(ins.sources ?? []).some((s) => s.pred === p))
            fail('PHI_EDGE_MISSING', `phi ${ins.id} has no source for predecessor edge ${p}->${b.id}`, pos);
      } else if (ins.kind === 'instr') {
        if (typeof ins.opcode !== 'string' || !ins.opcode) fail('INSTR_OPCODE_MISSING', `instr ${ins.id} missing opcode`, pos);
        (ins.defs ?? []).forEach((o, j) => checkOperand(o, { ...pos, operand: j }));
        (ins.uses ?? []).forEach((o, j) => checkOperand(o, { ...pos, operand: j }));
        for (const c of ins.clobbers ?? [])
          if (!physOf.has(c)) fail('CLOBBER_UNKNOWN', `instr ${ins.id} clobbers unknown phys reg ${c}`, pos);
      } else {
        fail('INSTR_KIND_UNKNOWN', `instr ${pos.instr} has unknown kind`, pos);
      }
    });
  }

  for (const pc of ir.precolors ?? []) {
    const cls = physOf.get(pc.phys);
    if (!cls) fail('PRECOLOR_PHYS_UNKNOWN', `precolor ${pc.vreg} -> unknown phys reg ${pc.phys}`);
  }
  return { ir: diagnostics.length ? undefined : ir, diagnostics };
}

export function renderInstr(ins: Instr): string {
  if (ins.kind === 'phi') {
    const srcs = ins.sources.map((s) => `[${s.vreg}, ${s.pred}]`).join(' ');
    return `${ins.id}: ${ins.def.vreg} = phi ${srcs}`;
  }
  const d = ins.defs.map((o) => o.vreg).join(', ');
  const u = ins.uses.map((o) => o.vreg).join(', ');
  const cl = ins.clobbers?.length ? ` clobbers ${ins.clobbers.join(',')}` : '';
  return `${ins.id}: ${d ? d + ' = ' : ''}${ins.opcode}${u ? ' ' + u : ''}${cl}`;
}

export function renderFunction(ir: FunctionIR): string[] {
  const lines: string[] = [];
  for (const b of ir.blocks) {
    lines.push(`${b.id}: ; loopDepth=${b.loopDepth} succs=${b.succs.join(',') || '-'}`);
    for (const ins of b.instrs) lines.push('  ' + renderInstr(ins));
  }
  return lines;
}
