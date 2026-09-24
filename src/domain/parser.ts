import type { Block, Diagnostic, FunctionMaterial, Instr, ParamSet, VRegRef } from './types';
import { parseQuantity } from './units';

export interface ParseOutcome {
  status: 'ok' | 'format_corrupt' | 'budget_exhausted';
  diagnostics: Diagnostic[];
  fn?: FunctionMaterial;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseVRegRef(raw: unknown, position: string, diags: Diagnostic[]): VRegRef | null {
  if (!isObj(raw) || typeof raw.v !== 'string' || typeof raw.class !== 'string') {
    diags.push({ position, severity: 'error', message: 'expected {"v": string, "class": string}' });
    return null;
  }
  return { v: raw.v, class: raw.class };
}

// Validates and normalizes a raw function description. Normalization only
// sorts serialization-level order (blocks, reg classes, regs); instruction
// order inside a block and every raw quantity string are preserved verbatim.
export function parseFunction(raw: unknown, params: ParamSet): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      return {
        status: 'format_corrupt',
        diagnostics: [
          { position: '$', severity: 'error', message: `invalid JSON: ${(err as Error).message}` },
        ],
      };
    }
  }
  if (!isObj(raw) || raw.kind !== 'function') {
    return {
      status: 'format_corrupt',
      diagnostics: [{ position: '$', severity: 'error', message: 'expected object with kind="function"' }],
    };
  }
  if (typeof raw.name !== 'string') {
    diagnostics.push({ position: '$.name', severity: 'error', message: 'function name must be a string' });
  }

  const regClassesRaw = Array.isArray(raw.regClasses) ? raw.regClasses : [];
  if (regClassesRaw.length === 0) {
    diagnostics.push({ position: '$.regClasses', severity: 'error', message: 'at least one register class is required' });
  }
  const classIds = new Set<string>();
  const pregOfClass = new Map<string, Set<string>>();
  const regClasses = [];
  for (const [ci, rc] of regClassesRaw.entries()) {
    const pos = `$.regClasses[${ci}]`;
    if (!isObj(rc) || typeof rc.id !== 'string' || !Array.isArray(rc.regs) || rc.regs.length === 0) {
      diagnostics.push({ position: pos, severity: 'error', message: 'register class needs id and non-empty regs[]' });
      continue;
    }
    classIds.add(rc.id);
    pregOfClass.set(rc.id, new Set(rc.regs as string[]));
    regClasses.push({ id: rc.id, regs: [...(rc.regs as string[])].sort() });
  }
  regClasses.sort((a, b) => (a.id < b.id ? -1 : 1));

  const abiRaw = isObj(raw.abi) ? raw.abi : {};
  const abi = {
    callerSaved: Array.isArray(abiRaw.callerSaved) ? (abiRaw.callerSaved as string[]) : [],
    argRegs: Array.isArray(abiRaw.argRegs) ? (abiRaw.argRegs as string[]) : [],
  };
  const allPregs = new Set([...pregOfClass.values()].flatMap((s) => [...s]));
  for (const p of [...abi.callerSaved, ...abi.argRegs]) {
    if (!allPregs.has(p)) {
      diagnostics.push({ position: '$.abi', severity: 'error', message: `ABI register "${p}" is not in any register class` });
    }
  }

  const blocksRaw = Array.isArray(raw.blocks) ? raw.blocks : [];
  if (blocksRaw.length === 0) {
    diagnostics.push({ position: '$.blocks', severity: 'error', message: 'function needs at least one block' });
  }
  const blocks: Block[] = [];
  const blockIds = new Set<string>();
  let instrCount = 0;
  const instrIds = new Set<string>();

  for (const [bi, braw] of blocksRaw.entries()) {
    const bpos = `$.blocks[${bi}]`;
    if (!isObj(braw) || typeof braw.id !== 'string') {
      diagnostics.push({ position: bpos, severity: 'error', message: 'block needs string id' });
      continue;
    }
    if (blockIds.has(braw.id)) {
      diagnostics.push({ position: bpos, severity: 'error', message: `duplicate block id "${braw.id}"` });
      continue;
    }
    blockIds.add(braw.id);
    const loopDepth = typeof braw.loopDepth === 'number' && braw.loopDepth >= 0 ? braw.loopDepth : 0;
    const instrsRaw = Array.isArray(braw.instrs) ? braw.instrs : [];
    const instrs: Instr[] = [];
    for (const [ii, iraw] of instrsRaw.entries()) {
      const ipos = `${bpos}.instrs[${ii}]`;
      instrCount += 1;
      if (instrCount > params.budget.maxInstrs) {
        return {
          status: 'budget_exhausted',
          diagnostics: [
            { position: ipos, severity: 'error', message: `instruction budget ${params.budget.maxInstrs} exhausted` },
          ],
        };
      }
      if (!isObj(iraw) || typeof iraw.id !== 'string' || typeof iraw.op !== 'string') {
        diagnostics.push({ position: ipos, severity: 'error', message: 'instruction needs id and op' });
        continue;
      }
      if (instrIds.has(iraw.id)) {
        diagnostics.push({ position: ipos, severity: 'error', message: `duplicate instruction id "${iraw.id}"` });
      }
      instrIds.add(iraw.id);
      const defs: VRegRef[] = [];
      const uses: VRegRef[] = [];
      for (const [di, d] of (Array.isArray(iraw.defs) ? iraw.defs : []).entries()) {
        const r = parseVRegRef(d, `${ipos}.defs[${di}]`, diagnostics);
        if (r) defs.push(r);
      }
      for (const [ui, u] of (Array.isArray(iraw.uses) ? iraw.uses : []).entries()) {
        const r = parseVRegRef(u, `${ipos}.uses[${ui}]`, diagnostics);
        if (r) uses.push(r);
      }
      const phiUses: Instr['phiUses'] = [];
      if (iraw.op === 'phi') {
        for (const [pi, p] of (Array.isArray(iraw.phiUses) ? iraw.phiUses : []).entries()) {
          if (isObj(p) && typeof p.v === 'string' && typeof p.pred === 'string') {
            phiUses.push({ v: p.v, pred: p.pred });
          } else {
            diagnostics.push({ position: `${ipos}.phiUses[${pi}]`, severity: 'error', message: 'phi use needs {v, pred}' });
          }
        }
      }
      const precolor: Record<string, string> = {};
      if (isObj(iraw.precolor)) {
        for (const [v, preg] of Object.entries(iraw.precolor)) {
          if (typeof preg !== 'string' || !allPregs.has(preg)) {
            diagnostics.push({ position: `${ipos}.precolor.${v}`, severity: 'error', message: `unknown physical register "${String(preg)}"` });
          } else {
            precolor[v] = preg;
          }
        }
      }
      const clobbers = Array.isArray(iraw.clobbers) ? (iraw.clobbers as string[]) : [];
      for (const c of clobbers) {
        if (!allPregs.has(c)) {
          diagnostics.push({ position: ipos, severity: 'error', message: `clobber "${c}" is not a physical register` });
        }
      }
      const cost = iraw.cost !== undefined ? parseQuantity(iraw.cost, `${ipos}.cost`) : null;
      if (cost?.diagnostic) diagnostics.push(cost.diagnostic);
      instrs.push({
        id: iraw.id,
        op: iraw.op,
        coord: `${braw.id}:${ii}`,
        defs,
        uses,
        phiUses,
        precolor,
        clobbers,
        move: iraw.move === true,
        crossClass: iraw.crossClass === true,
        cost,
        text: typeof iraw.text === 'string' ? iraw.text : `${iraw.op} ${iraw.id}`,
      });
    }
    blocks.push({
      id: braw.id,
      loopDepth,
      instrs,
      succs: Array.isArray(braw.succs) ? (braw.succs as string[]) : [],
    });
  }

  // Cross-block reference checks (positions point at the referencing site).
  for (const b of blocks) {
    for (const s of b.succs) {
      if (!blockIds.has(s)) {
        diagnostics.push({ position: `$.blocks[${b.id}].succs`, severity: 'error', message: `successor "${s}" does not exist` });
      }
    }
  }
  const predsOf = new Map<string, Set<string>>();
  for (const b of blocks) for (const s of b.succs) {
    if (!predsOf.has(s)) predsOf.set(s, new Set());
    predsOf.get(s)!.add(b.id);
  }
  for (const b of blocks) {
    for (const ins of b.instrs) {
      for (const pu of ins.phiUses) {
        if (!predsOf.get(b.id)?.has(pu.pred)) {
          diagnostics.push({
            position: `$.blocks[${b.id}].instrs[${ins.id}].phiUses`,
            severity: 'error',
            message: `phi use names predecessor "${pu.pred}" which is not a CFG predecessor of block "${b.id}"`,
          });
        }
      }
      for (const ref of [...ins.defs, ...ins.uses]) {
        if (!classIds.has(ref.class)) {
          diagnostics.push({
            position: `$.blocks[${b.id}].instrs[${ins.id}]`,
            severity: 'error',
            message: `vreg "${ref.v}" references unknown register class "${ref.class}"`,
          });
        }
      }
      for (const [v, preg] of Object.entries(ins.precolor)) {
        const def = ins.defs.find((d) => d.v === v);
        if (def && pregOfClass.get(def.class) && !pregOfClass.get(def.class)!.has(preg)) {
          diagnostics.push({
            position: `$.blocks[${b.id}].instrs[${ins.id}].precolor`,
            severity: 'error',
            message: `precolor ${v}→${preg} crosses register class of ${v} (${def.class})`,
          });
        }
      }
    }
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { status: 'format_corrupt', diagnostics };
  }
  blocks.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    status: 'ok',
    diagnostics,
    fn: {
      kind: 'function',
      name: typeof raw.name === 'string' ? raw.name : '<unnamed>',
      regClasses,
      abi,
      blocks,
    },
  };
}

export const DEFAULT_PARAMS: ParamSet = {
  version: 'pv1',
  loopWeightBase: 10,
  loopWeightExponent: 1,
  coalesceRule: 'briggs',
  budget: { maxInstrs: 512, maxSimplifySteps: 4096, maxSpillRounds: 8 },
};
