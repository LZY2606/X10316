import type { Block, Diagnostic, Instr, Program, Quantity } from './types';

// 文本 DSL 解析：格式损坏与输入不完整是不同结果。
// 所有诊断都带位置；不得用空值或默认值伪装成功。

export interface ParseOutcome {
  program?: Program;
  diagnostics: Diagnostic[];
  corrupt: boolean; // true => format_corrupt（结构性损坏，无法形成语法树）
}

export function parseProgram(text: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { diagnostics: [{ severity: 'error', code: 'empty-input', message: '输入为空', location: '<input>' }], corrupt: true };
  }
  const lines = text.split(/\r?\n/);
  const program: Program = {
    kind: 'program', func: '', entry: '',
    registerClasses: [], vregs: {}, precolors: {}, callClobbers: {}, blocks: [],
  };
  let cur: Block | null = null;
  let corrupt = false;

  const err = (line: number, code: string, message: string) =>
    diagnostics.push({ severity: 'error', code, message, location: `line ${line + 1}` });

  lines.forEach((raw, li) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const toks = line.split(/\s+/);
    const head = toks[0];
    try {
      if (head === 'func') {
        if (toks.length !== 2) { err(li, 'bad-arity', 'func 需要 1 个参数'); corrupt = true; return; }
        program.func = toks[1];
      } else if (head === 'class') {
        if (toks.length < 3) { err(li, 'bad-arity', 'class 需要名称和至少一个物理寄存器'); corrupt = true; return; }
        program.registerClasses.push({ name: toks[1], regs: toks.slice(2) });
      } else if (head === 'vreg') {
        if (toks.length < 3) { err(li, 'bad-arity', 'vreg 需要名称和寄存器类'); corrupt = true; return; }
        const info: { name: string; cls: string; spillCost?: Quantity } = { name: toks[1], cls: toks[2] };
        const sc = toks.find((t) => t.startsWith('spillcost='));
        if (sc) {
          const [, num, unit] = sc.split(/[=@]/);
          const value = Number(num);
          if (!Number.isFinite(value)) { err(li, 'bad-quantity', `spillcost 数值无法解析: ${sc}`); return; }
          info.spillCost = { value, unit: unit || 'spill-cost', basis: 'manual-annotation' };
        }
        program.vregs[info.name] = info;
      } else if (head === 'precolor') {
        if (toks.length !== 3) { err(li, 'bad-arity', 'precolor 需要 vreg 和 preg'); corrupt = true; return; }
        program.precolors[toks[1]] = toks[2];
      } else if (head === 'block') {
        if (toks.length < 2) { err(li, 'bad-arity', 'block 需要 id'); corrupt = true; return; }
        cur = { id: toks[1], instrs: [], successors: [] };
        const ld = toks.find((t) => t.startsWith('loopdepth='));
        if (ld) cur.loopDepth = Number(ld.split('=')[1]);
        program.blocks.push(cur);
        if (!program.entry) program.entry = cur.id;
      } else if (head === 'succ') {
        if (!cur) { err(li, 'stray-directive', 'succ 出现在 block 之外'); corrupt = true; return; }
        cur.successors.push(...toks.slice(1));
      } else if (/^[A-Za-z_][\w.-]*:/.test(head)) {
        if (!cur) { err(li, 'stray-instr', '指令出现在 block 之外'); corrupt = true; return; }
        const instr = parseInstr(head.slice(0, -1), toks.slice(1), li, err);
        if (instr) cur.instrs.push(instr);
      } else {
        err(li, 'unknown-directive', `无法识别的指令: ${head}`);
        corrupt = true;
      }
    } catch (e) {
      err(li, 'parse-exception', `解析异常: ${(e as Error).message}`);
      corrupt = true;
    }
  });

  if (!program.func) {
    diagnostics.push({ severity: 'error', code: 'missing-field', message: '缺少 func 声明', location: 'program.func' });
  }
  if (corrupt || diagnostics.some((d) => d.severity === 'error')) return { diagnostics, corrupt: true };
  // 补齐原始顺序坐标（point 是原始指令顺序的坐标基准）
  for (const b of program.blocks) {
    b.instrs.forEach((ins, i) => { ins.point = { func: program.func, block: b.id, index: i }; });
    for (const ins of b.instrs) {
      if (ins.clobbers?.length) program.callClobbers[ins.id] = ins.clobbers;
    }
  }
  return { program, diagnostics, corrupt: false };
}

function parseInstr(
  id: string, toks: string[], li: number,
  err: (line: number, code: string, msg: string) => void,
): Instr | null {
  if (toks.length < 1) { err(li, 'bad-instr', `指令 ${id} 缺少操作码`); return null; }
  const instr: Instr = { id, op: toks[0], defs: [], uses: [] };
  for (const t of toks.slice(1)) {
    const [k, v] = t.split('=');
    if (k === 'defs') instr.defs = v ? v.split(',').filter(Boolean) : [];
    else if (k === 'uses') instr.uses = v ? v.split(',').filter(Boolean) : [];
    else if (k === 'args') {
      instr.phiArgs = (v ? v.split(',').filter(Boolean) : []).map((pair) => {
        const [pred, vreg] = pair.split(':');
        if (!pred || !vreg) { err(li, 'bad-phi-arg', `phi 参数应为 pred:vreg: ${pair}`); }
        return { pred, vreg };
      });
    } else if (k === 'clobbers') instr.clobbers = v ? v.split(',').filter(Boolean) : [];
    else if (t === 'move') instr.isMove = true;
    else { err(li, 'bad-field', `指令 ${id} 的未知字段: ${t}`); return null; }
  }
  if (instr.op === 'phi' && !instr.phiArgs?.length) {
    err(li, 'bad-phi', `phi 指令 ${id} 缺少 args=`); return null;
  }
  return instr;
}

// 结构校验：输入不完整 => 带位置诊断（不是 format_corrupt）
export function validateProgram(p: Program): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const classes = new Map(p.registerClasses.map((c) => [c.name, c]));
  if (!p.registerClasses.length) diags.push({ severity: 'error', code: 'missing-field', message: '缺少寄存器类', location: 'program.registerClasses' });
  if (!p.blocks.length) diags.push({ severity: 'error', code: 'missing-field', message: '缺少基本块', location: 'program.blocks' });
  const blockIds = new Set(p.blocks.map((b) => b.id));
  p.blocks.forEach((b, bi) => {
    b.successors.forEach((s) => {
      if (!blockIds.has(s)) diags.push({ severity: 'error', code: 'dangling-edge', message: `CFG 边指向不存在的块 ${s}`, location: `program.blocks[${bi}].successors` });
    });
    b.instrs.forEach((ins, ii) => {
      const loc = `program.blocks[${bi}].instrs[${ii}]`;
      for (const v of [...ins.defs, ...ins.uses, ...(ins.phiArgs?.map((a) => a.vreg) ?? [])]) {
        if (!p.vregs[v]) diags.push({ severity: 'error', code: 'unknown-vreg', message: `未声明的虚拟寄存器 ${v}`, location: loc });
      }
      ins.phiArgs?.forEach((a) => {
        if (!blockIds.has(a.pred)) diags.push({ severity: 'error', code: 'dangling-edge', message: `phi 前驱 ${a.pred} 不存在`, location: `${loc}.phiArgs` });
      });
    });
  });
  for (const [name, info] of Object.entries(p.vregs)) {
    if (!classes.has(info.cls)) diags.push({ severity: 'error', code: 'unknown-class', message: `vreg ${name} 的寄存器类 ${info.cls} 未声明`, location: `program.vregs.${name}` });
  }
  for (const [v, preg] of Object.entries(p.precolors)) {
    const info = p.vregs[v];
    if (!info) { diags.push({ severity: 'error', code: 'unknown-vreg', message: `预着色引用了未声明的 vreg ${v}`, location: `program.precolors.${v}` }); continue; }
    const cls = classes.get(info.cls);
    if (cls && !cls.regs.includes(preg)) diags.push({ severity: 'error', code: 'bad-precolor', message: `预着色 ${v} -> ${preg} 不在寄存器类 ${info.cls} 中`, location: `program.precolors.${v}` });
  }
  return diags;
}
