import type {
  Block,
  Diagnostic,
  Instruction,
  Materials,
  Operand,
  ParseOutcome,
  Precolor,
  RegClass,
} from './types.js';
import { parseQuantity } from './units.js';
import { sha256 } from './util.js';

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VREG = /^%([A-Za-z0-9_]+)(?::(\w+))?$/;

function operand(token: string): Operand | null {
  const m = token.match(VREG);
  if (!m || !m[2]) return null;
  return { name: '%' + m[1], cls: m[2] };
}

function vregName(token: string): string | null {
  const m = token.match(VREG);
  return m ? '%' + m[1] : null;
}

function parseInstruction(rest: string, lineNo: number, rawLine: string, diags: Diagnostic[]): Instruction | null {
  const head = rest.match(/^(\S+)\s+@(\S+)\s+(.*)$/s);
  if (!head) {
    diags.push({ severity: 'error', message: `指令缺少 id @block 头: ${rest.trim()}`, line: lineNo, col: 1 });
    return null;
  }
  const [, id, block, body] = head;
  if (!ID.test(id)) diags.push({ severity: 'error', message: `非法指令 id: ${id}`, line: lineNo });
  if (!ID.test(block)) diags.push({ severity: 'error', message: `非法块名: ${block}`, line: lineNo });

  const colOf = (snippet: string) => rawLine.indexOf(snippet) + 1;
  const instr: Instruction = {
    id, block, order: -1, op: 'op', defs: [], uses: [], phiUses: [],
    move: null, call: false, clobbers: [], line: lineNo, raw: rawLine.trim(),
  };

  const mMove = body.match(/^move\s+(%[\w.]+):(\w+)\s+<-\s+(%[\w.]+):(\w+)$/);
  const mPhi = body.match(/^phi\s+(%[\w.]+):(\w+)\s+=\s+\[(.*)\]$/s);
  const mCall = body.match(/^call\s+(\S+)(?:\s+clobber\s+(.+))?$/s);
  const mBr = body.match(/^br\s+(%[\w.]+)\s+->\s+(.+)$/s);
  const mRet = body.match(/^ret\s+(%[\w.]+)$/s);

  if (mMove) {
    instr.op = 'move';
    instr.defs = [{ name: mMove[1], cls: mMove[2] }];
    instr.uses = [{ name: mMove[3], cls: mMove[4] }];
    instr.move = { from: mMove[3], to: mMove[1], fromClass: mMove[4], toClass: mMove[2] };
    return instr;
  }
  if (mPhi) {
    instr.op = 'phi';
    instr.defs = [{ name: mPhi[1], cls: mPhi[2] }];
    const entries = mPhi[3].split(',').map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const em = entry.match(/^(\w+):(%[\w.]+)$/);
      if (!em) {
        diags.push({ severity: 'error', message: `phi 操作数格式错误，应为 前驱:%vreg: ${entry}`, line: lineNo, col: colOf(entry) });
        continue;
      }
      instr.phiUses.push({ pred: em[1], name: em[2] });
    }
    return instr;
  }
  if (mCall) {
    instr.op = 'call';
    instr.call = true;
    if (mCall[2]) instr.clobbers = mCall[2].trim().split(/\s+/);
    return instr;
  }
  if (mBr) {
    instr.op = 'br';
    const name = vregName(mBr[1]);
    if (name) instr.uses = [{ name, cls: '' }];
    instr.clobbers = mBr[2].trim().split(/\s+/); // br 目标块复用字段语义不合适，单独挂
    instr.clobbers = [];
    (instr as unknown as { targets: string[] }).targets = mBr[2].trim().split(/\s+/);
    return instr;
  }
  if (mRet) {
    instr.op = 'ret';
    const name = vregName(mRet[1]);
    if (name) instr.uses = [{ name, cls: '' }];
    return instr;
  }

  // 通用形式: def %v:CLS ... [use %v ...] [op NAME]
  const tokens = body.split(/\s+/);
  let i = 0;
  const parseDefList = (startToken: string) => {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith('%')) {
      const op = operand(tokens[i]);
      if (!op) {
        diags.push({ severity: 'error', message: `def 操作数必须带寄存器类: ${tokens[i]}`, line: lineNo, col: colOf(tokens[i]) });
      } else {
        instr.defs.push(op);
      }
      i += 1;
    }
    void startToken;
  };
  if (tokens[i] === 'def') {
    parseDefList(tokens[i]);
  }
  if (tokens[i] === 'use') {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith('%')) {
      const tok = tokens[i];
      const m = tok.match(VREG)!;
      instr.uses.push({ name: '%' + m[1], cls: m[2] ?? '' });
      i += 1;
    }
  }
  if (tokens[i] === 'op') {
    if (!tokens[i + 1]) {
      diags.push({ severity: 'error', message: 'op 后缺少操作名', line: lineNo, col: colOf('op') });
    } else {
      instr.op = tokens[i + 1];
      i += 2;
    }
  }
  if (i < tokens.length) {
    diags.push({ severity: 'error', message: `无法识别的指令片段: ${tokens.slice(i).join(' ')}`, line: lineNo, col: colOf(tokens[i]) });
  }
  if (!instr.defs.length && !instr.uses.length && !instr.call && instr.op === 'op') {
    diags.push({ severity: 'error', message: '指令缺少 def/use', line: lineNo });
  }
  return instr;
}

export function parseMaterials(source: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const classes: RegClass[] = [];
  const precolors: Precolor[] = [];
  const blocks: Block[] = [];
  const edges: { from: string; to: string }[] = [];
  const instructions: Instruction[] = [];

  let blockOrder = 0;
  let instrOrder = 0;
  const lines = source.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^class\s+(\w+)\s*\{\s*([^}]*)\}$/))) {
      const regs = m[2].trim().split(/\s+/).filter(Boolean);
      classes.push({ name: m[1], regs });
      if (regs.length === 0) diagnostics.push({ severity: 'error', message: `寄存器类 ${m[1]} 为空`, line: lineNo });
    } else if ((m = line.match(/^precolor\s+(%[\w.]+)\s*->\s*(\w+)$/))) {
      precolors.push({ vreg: m[1], phys: m[2], line: lineNo });
    } else if ((m = line.match(/^block\s+(\w+)\s+weight\s+(.+)$/))) {
      const weight = parseQuantity(m[2].trim());
      if (weight.diagnostic) {
        diagnostics.push({ severity: 'warning', message: `block ${m[1]} 权重不可转换: ${weight.diagnostic}（原始表示保留在原位）`, line: lineNo });
      }
      blocks.push({ name: m[1], order: blockOrder++, weight, succs: [] });
    } else if ((m = line.match(/^edge\s+(\w+)\s*->\s*(\w+)$/))) {
      edges.push({ from: m[1], to: m[2] });
    } else if (line.startsWith('instr ')) {
      const instr = parseInstruction(line.slice('instr '.length), lineNo, rawLine, diagnostics);
      if (instr) {
        instr.order = instrOrder++;
        instructions.push(instr);
      }
    } else {
      diagnostics.push({ severity: 'error', message: `无法识别的行: ${line}`, line: lineNo, col: 1 });
    }
  });

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  // —— 语义校验：输入不完整时给带位置的诊断，不用空值/默认值伪装成功 ——
  const blockNames = new Set(blocks.map((b) => b.name));
  const classNames = new Map(classes.map((c) => [c.name, c]));
  if (classes.length === 0) diagnostics.push({ severity: 'error', message: '缺少寄存器类声明（class）' });
  if (blocks.length === 0) diagnostics.push({ severity: 'error', message: '缺少基本块声明（block）' });

  for (const e of edges) {
    if (!blockNames.has(e.from)) diagnostics.push({ severity: 'error', message: `边引用了不存在的块: ${e.from}` });
    if (!blockNames.has(e.to)) diagnostics.push({ severity: 'error', message: `边引用了不存在的块: ${e.to}` });
  }

  for (const instr of instructions) {
    if (!blockNames.has(instr.block)) {
      diagnostics.push({ severity: 'error', message: `指令 ${instr.id} 引用不存在的块 @${instr.block}`, line: instr.line });
    }
  }

  // vreg -> 定义所在类（SSA/虚拟寄存器文本中 def 必须带类）
  const defClass = new Map<string, { cls: string; line: number }>();
  const registerDef = (name: string, cls: string, line: number) => {
    const prev = defClass.get(name);
    if (prev) {
      diagnostics.push({ severity: 'error', message: `虚拟寄存器 ${name} 重复 def（先见于第 ${prev.line} 行）`, line });
    } else {
      defClass.set(name, { cls, line });
    }
  };
  for (const instr of instructions) {
    for (const d of instr.defs) registerDef(d.name, d.cls, instr.line);
  }

  // 补全 use 的寄存器类
  for (const instr of instructions) {
    for (const u of instr.uses) {
      if (!u.cls) {
        const def = defClass.get(u.name);
        if (!def) {
          diagnostics.push({ severity: 'error', message: `use 引用了未定义的虚拟寄存器 ${u.name}`, line: instr.line });
        } else {
          u.cls = def.cls;
        }
      }
    }
    for (const pu of instr.phiUses) {
      const def = defClass.get(pu.name);
      if (!def) {
        diagnostics.push({ severity: 'error', message: `phi 使用引用了未定义的虚拟寄存器 ${pu.name}`, line: instr.line });
      }
    }
  }

  // 寄存器类存在性
  for (const instr of instructions) {
    for (const d of instr.defs) {
      if (!classNames.has(d.cls)) diagnostics.push({ severity: 'error', message: `未知寄存器类 ${d.cls}`, line: instr.line });
    }
    for (const u of instr.uses) {
      if (u.cls && !classNames.has(u.cls)) diagnostics.push({ severity: 'error', message: `未知寄存器类 ${u.cls}`, line: instr.line });
    }
  }

  // 预着色：物理寄存器存在、类一致
  for (const p of precolors) {
    const found = classes.find((c) => c.regs.includes(p.phys));
    if (!found) {
      diagnostics.push({ severity: 'error', message: `预着色引用不存在的物理寄存器 ${p.phys}`, line: p.line });
      continue;
    }
    const def = defClass.get(p.vreg);
    if (!def) {
      diagnostics.push({ severity: 'error', message: `预着色引用未定义的虚拟寄存器 ${p.vreg}`, line: p.line });
    } else if (def.cls !== found.name) {
      diagnostics.push({ severity: 'error', message: `预着色跨类: ${p.vreg} 属于 ${def.cls}，${p.phys} 属于 ${found.name}`, line: p.line });
    }
  }

  // clobber 必须是已声明物理寄存器；br 目标必须在后继中
  for (const instr of instructions) {
    if (instr.call) {
      for (const r of instr.clobbers) {
        if (!classes.some((c) => c.regs.includes(r))) {
          diagnostics.push({ severity: 'error', message: `clobber 引用不存在的物理寄存器 ${r}`, line: instr.line });
        }
      }
    }
    const targets = (instr as unknown as { targets?: string[] }).targets;
    if (targets) {
      const declared = edges.filter((e) => e.from === instr.block).map((e) => e.to);
      for (const t of targets) {
        if (!declared.includes(t)) {
          diagnostics.push({ severity: 'error', message: `br 目标 ${t} 不在 @${instr.block} 的 edge 后继中`, line: instr.line });
        }
      }
    }
  }

  // phi 前驱边必须存在
  for (const instr of instructions) {
    if (instr.op !== 'phi') continue;
    for (const pu of instr.phiUses) {
      if (!edges.some((e) => e.from === pu.pred && e.to === instr.block)) {
        diagnostics.push({ severity: 'error', message: `phi ${instr.id} 的前驱 ${pu.pred} 没有指向 @${instr.block} 的边`, line: instr.line });
      }
    }
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  for (const e of edges) {
    const block = blocks.find((b) => b.name === e.from)!;
    block.succs.push(e.to);
  }

  const moves = instructions
    .filter((i) => i.op === 'move')
    .map((i) => ({
      instrId: i.id,
      from: i.move!.from,
      to: i.move!.to,
      fromClass: i.move!.fromClass,
      toClass: i.move!.toClass,
    }));

  instructions.sort((a, b) => a.order - b.order);

  const digest = sha256(source);
  const materials: Materials = {
    id: 'mat_' + digest.slice(0, 16),
    source,
    digest,
    classes,
    precolors,
    blocks,
    edges,
    instructions,
    moves,
    diagnostics: diagnostics.filter((d) => d.severity === 'warning'),
  };
  return { ok: true, materials };
}
