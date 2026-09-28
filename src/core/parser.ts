import { diag, isFatal, type DiagnosticError } from "./diagnostics.js";
import type {
  Block,
  CallingConvention,
  Diagnostic,
  Func,
  Instr,
  Operand,
  RegisterClass,
  SourceSnapshot
} from "./types.js";
import { shortHash, sortVregs } from "./ids.js";

interface ParseState {
  lines: string[];
  regClasses: Map<string, RegisterClass>;
  conventions: Map<string, CallingConvention>;
  diags: Diagnostic[];
}

const PHYS = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const VIRT = /^v\d+$/;

function classOf(reg: string, st: ParseState): string | null {
  for (const rc of st.regClasses.values()) {
    if (rc.members.includes(reg)) return rc.id;
  }
  return null;
}

function parseOperand(tok: string, defaultClass: string | null, st: ParseState, line: number, col: number): Operand {
  let text = tok;
  let rawClassToken: string | undefined;
  let regClassId = defaultClass ?? "";
  // Class suffix: v3:GPR32 or $xmm0:VEC128
  const colon = tok.indexOf(":");
  if (colon >= 0) {
    rawClassToken = tok.slice(colon + 1);
    tok = tok.slice(0, colon);
    if (!st.regClasses.has(rawClassToken)) {
      st.diags.push(
        diag("SEMANTIC_UNSAT", `unknown register class '${rawClassToken}'`, { line, column: col + colon + 1 }, tok)
      );
    } else {
      regClassId = rawClassToken;
    }
  }
  let opClass: Operand["opClass"];
  let ref: string;
  if (VIRT.test(tok)) {
    opClass = "virt";
    ref = tok.slice(1);
  } else if (PHYS.test(tok)) {
    opClass = "phys";
    ref = tok;
    const inferred = classOf(tok, st);
    if (inferred === null) {
      st.diags.push(diag("SEMANTIC_UNSAT", `physical register ${tok} is not a member of any register class`, { line, column: col }, tok));
    } else if (rawClassToken && inferred !== rawClassToken) {
      st.diags.push(diag("SEMANTIC_UNSAT", `${tok} belongs to class ${inferred}, not declared class ${rawClassToken}`, { line, column: col }, tok));
    } else {
      regClassId = inferred;
    }
  } else {
    st.diags.push(diag("FORMAT_CORRUPT", `unparseable operand '${tok}' (expected vN or $name)`, { line, column: col }, tok));
    opClass = "virt";
    ref = tok;
  }
  if (opClass === "virt" && !regClassId) {
    st.diags.push(diag("INPUT_INCOMPLETE", `virtual operand ${tok} has no register class (suffix :ClassId required)`, { line, column: col }, tok));
  }
  return { text, opClass, ref, regClassId, rawClassToken };
}

function splitTokens(s: string): string[] {
  return s.split(/[,\s]+/).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

function parseClassDirective(args: string, st: ParseState, line: number) {
  // class GPR32 gpr 32 $rax,$rbx,$rcx
  const m = args.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/);
  if (!m) {
    st.diags.push(diag("FORMAT_CORRUPT", "class directive expects: class <id> <kind> <widthBits> <$reg,...>", { line, column: 1 }, args));
    return;
  }
  const [, id, kind, width, membersRaw] = m;
  const widthBits = Number(width);
  if (!Number.isInteger(widthBits) || widthBits <= 0) {
    st.diags.push(diag("FORMAT_CORRUPT", `class width must be a positive integer, got '${width}'`, { line, column: 1 }, width));
  }
  const members = splitTokens(membersRaw!);
  for (const mem of members) {
    if (!PHYS.test(mem)) {
      st.diags.push(diag("FORMAT_CORRUPT", `class member must be a physical register ($name), got '${mem}'`, { line, column: 1 }, mem));
    }
  }
  const uniq = new Set(members);
  if (uniq.size !== members.length) {
    st.diags.push(diag("SEMANTIC_UNSAT", `class ${id} declares duplicate members`, { line, column: 1 }, membersRaw));
  }
  if (st.regClasses.has(id!)) {
    st.diags.push(diag("SEMANTIC_UNSAT", `duplicate register class '${id}'`, { line, column: 1 }, id));
  }
  st.regClasses.set(id!, { id: id!, kind: kind!, widthBits, members });
}

function parseCconvDirective(args: string, st: ParseState, line: number) {
  // cconv C_DEFAULT caller=$rax,$rcx args=$rdi,$rsi returns=$rax callee=$rbx
  const idMatch = args.match(/^(\S+)/);
  if (!idMatch) {
    st.diags.push(diag("FORMAT_CORRUPT", "cconv directive requires an id", { line, column: 1 }));
    return;
  }
  const id = idMatch[1]!;
  const fields: Record<string, string[]> = {};
  for (const mm of args.matchAll(/(caller|args|returns|callee)\s*=\s*([^\s]+(?:,[^\s]+)*)/g)) {
    fields[mm[1]!] = splitTokens(mm[2]!);
  }
  const need = ["caller", "args", "returns", "callee"];
  for (const key of need) {
    if (!fields[key]) {
      st.diags.push(diag("INPUT_INCOMPLETE", `cconv ${id} missing field '${key}='`, { line, column: 1 }, args));
      fields[key] = [];
    }
  }
  for (const key of need) {
    for (const reg of fields[key]!) {
      if (!classOf(reg, st)) {
        st.diags.push(diag("SEMANTIC_UNSAT", `cconv ${id} references ${reg} which is not a member of any class`, { line, column: 1 }, reg));
      }
    }
  }
  if (st.conventions.has(id)) {
    st.diags.push(diag("SEMANTIC_UNSAT", `duplicate calling convention '${id}'`, { line, column: 1 }, id));
  }
  st.conventions.set(id, {
    id,
    callerSaved: fields.caller!,
    argumentRegs: fields.args!,
    returnRegs: fields.returns!,
    calleeSaved: fields.callee!
  });
}

// ---------------------------------------------------------------------------
// Function + instructions
// ---------------------------------------------------------------------------

const TERMINATOR_OPCODES = new Set(["br", "cbr", "ret", "switch"]);

interface FuncBuild {
  name: string;
  cconvId: string | null;
  blocks: Block[];
  instrs: Instr[];
  line: number;
}

function parseOperandList(raw: string, cls: string | null, st: ParseState, line: number): Operand[] {
  if (raw.trim() === "_") return [];
  return splitTokens(raw).map((tok, i) =>
    parseOperand(tok, cls, st, line, raw.indexOf(tok, raw.split(tok)[0]!.length) + 1 || i + 1)
  );
}

function parseFunc(name: string, cconvId: string | null, body: string[], startLine: number, st: ParseState): FuncBuild {
  const diags = st.diags;
  const blocks: Block[] = [];
  const instrs: Instr[] = [];
  let cur: Block | null = null;
  let instrSeq = 0;
  let blockSeq = 0;

  const ensureBlock = (ln: number, label?: string): Block => {
    if (!cur) {
      cur = {
        id: `b${blockSeq++}`,
        label: label ?? `bb${blocks.length}`,
        instrIds: [],
        successorIds: [],
        predecessorIds: [],
        line: ln
      };
      blocks.push(cur);
    }
    return cur;
  };

  for (let li = 0; li < body.length; li++) {
    const lineNo = startLine + li;
    const raw = body[li]!;
    const code = raw.replace(/;.*$/, "").trim();
    if (!code) continue;

    const labelM = code.match(/^([A-Za-z_.][\w.]*):$/);
    if (labelM) {
      if (cur && cur.instrIds.length === 0 && cur.label === `bb${blocks.length - 1}`) {
        cur.label = labelM[1]!;
      } else {
        cur = {
          id: `b${blockSeq++}`,
          label: labelM[1]!,
          instrIds: [],
          successorIds: [],
          predecessorIds: [],
          line: lineNo
        };
        blocks.push(cur);
      }
      continue;
    }

    cur = ensureBlock(lineNo);

    // phi: %x:GPR32 = phi [v1:L0] [v2:L1]
    const phiM = code.match(/^(\S+)\s*=\s*phi\s+(.+)$/);
    if (phiM) {
      const def = parseOperand(phiM[1]!, null, st, lineNo, 1);
      const instr: Instr = {
        id: `i${instrSeq++}`,
        index: instrs.length,
        blockId: cur.id,
        opcode: "phi",
        defs: [def],
        uses: [],
        clobbers: [],
        phiUses: [],
        isMove: false,
        precolors: [],
        text: code,
        line: lineNo
      };
      const pairs = phiM[2]!.matchAll(/\[([^\]]+)\]/g);
      for (const p of pairs) {
        const inside = p[1]!.trim();
        const ci = inside.lastIndexOf(":");
        if (ci < 0) {
          diags.push(diag("FORMAT_CORRUPT", "phi use must be [operand:label]", { line: lineNo, column: 1 }, inside));
          continue;
        }
        const opTok = inside.slice(0, ci).trim();
        const predLabel = inside.slice(ci + 1).trim();
        const operand = parseOperand(opTok, def.regClassId, st, lineNo, 1);
        instr.phiUses.push({ operand, predBlockId: predLabel });
      }
      if (instr.phiUses.length === 0) {
        diags.push(diag("INPUT_INCOMPLETE", "phi has no [operand:label] pairs", { line: lineNo, blockId: cur.id }, code));
      }
      pushInstr(cur, instr, instrs);
      continue;
    }

    // move: dst = move src   (cross-class when suffix classes differ)
    const moveM = code.match(/^(\S+)\s*=\s*move\s+(\S+)(?:\s+clobber\s+(.+))?$/);
    if (moveM) {
      const def = parseOperand(moveM[1]!, null, st, lineNo, 1);
      const use = parseOperand(moveM[2]!, def.regClassId, st, lineNo, 1);
      const clobbers = moveM[3] ? splitTokens(moveM[3]) : [];
      checkClobbers(clobbers, st, lineNo, cconvId);
      const precolors: Instr["precolors"] = [];
      for (const o of [def, use]) {
        if (o.opClass === "phys") precolors.push({ operand: counterpart(o, def, use), phys: o.ref });
      }
      pushInstr(cur, mkInstr(instrSeq++, instrs.length, cur.id, "move", [def], [use], clobbers, true, precolors, code, lineNo), instrs);
      continue;
    }

    // call: dst = call name ( args ) clobber $rax,$rcx
    const callM = code.match(/^(?:(\S+)\s*=\s*)?call\s+(\S+)(?:\s*\(([^)]*)\))?(?:\s+clobber\s+(.+))?$/);
    if (callM) {
      const defs: Operand[] = callM[1] ? [parseOperand(callM[1], null, st, lineNo, 1)] : [];
      const uses: Operand[] = callM[3] ? parseOperandList(callM[3], null, st, lineNo) : [];
      let clobbers = callM[4] ? splitTokens(callM[4]) : [];
      if (clobbers.length === 0 && cconvId) {
        clobbers = st.conventions.get(cconvId)?.callerSaved ?? [];
      }
      checkClobbers(clobbers, st, lineNo, cconvId);
      pushInstr(cur, mkInstr(instrSeq++, instrs.length, cur.id, `call ${callM[2]}`, defs, uses, clobbers, false, [], code, lineNo), instrs);
      continue;
    }

    // terminators: ret x | br L | cbr cond, L, L | switch x, L, L, ...
    const retM = code.match(/^ret(?:\s+(.+))?$/);
    const brM = code.match(/^br\s+(\S+)$/);
    const cbrM = code.match(/^cbr\s+(\S+)\s*,\s*(\S+)\s*,\s*(\S+)$/);
    const switchM = code.match(/^switch\s+(\S+)\s*,\s*(.+)$/);
    if (retM) {
      const uses = retM[1] ? parseOperandList(retM[1], null, st, lineNo) : [];
      const ins = mkInstr(instrSeq++, instrs.length, cur.id, "ret", [], uses, [], false, [], code, lineNo);
      ins.terminator = { kind: "ret", successors: [] };
      pushInstr(cur, ins, instrs);
      continue;
    }
    if (cbrM) {
      const cond = parseOperand(cbrM[1]!, null, st, lineNo, 1);
      const ins = mkInstr(instrSeq++, instrs.length, cur.id, "cbr", [], [cond], [], false, [], code, lineNo);
      ins.terminator = { kind: "cbr", successors: [cbrM[2]!, cbrM[3]!] };
      pushInstr(cur, ins, instrs);
      continue;
    }
    if (brM) {
      const ins = mkInstr(instrSeq++, instrs.length, cur.id, "br", [], [], [], false, [], code, lineNo);
      ins.terminator = { kind: "br", successors: [brM[1]!] };
      pushInstr(cur, ins, instrs);
      continue;
    }
    if (switchM) {
      const sel = parseOperand(switchM[1]!, null, st, lineNo, 1);
      const targets = splitTokens(switchM[2]!);
      const ins = mkInstr(instrSeq++, instrs.length, cur.id, "switch", [], [sel], [], false, [], code, lineNo);
      ins.terminator = { kind: "switch", successors: targets };
      pushInstr(cur, ins, instrs);
      continue;
    }

    // generic: d1, d2 = opcode u1, u2 [clobber $x]
    const genM = code.match(/^(?:([^=]+?)\s*=\s*)?([a-z][\w.]*)(?:\s+(.+?))?(?:\s+clobber\s+(.+))?$/);
    if (genM && !TERMINATOR_OPCODES.has(genM[2]!)) {
      const defs = genM[1] ? parseOperandList(genM[1], null, st, lineNo) : [];
      const uses = genM[3] ? parseOperandList(genM[3], null, st, lineNo) : [];
      const clobbers = genM[4] ? splitTokens(genM[4]) : [];
      checkClobbers(clobbers, st, lineNo, cconvId);
      pushInstr(cur, mkInstr(instrSeq++, instrs.length, cur.id, genM[2]!, defs, uses, clobbers, false, [], code, lineNo), instrs);
      continue;
    }

    diags.push(diag("FORMAT_CORRUPT", `unrecognized instruction '${code}'`, { line: lineNo, blockId: cur.id }, code));
  }

  return { name, cconvId, blocks, instrs, line: startLine };
}

function counterpart(o: Operand, def: Operand, use: Operand): Operand {
  return o === def ? use : def;
}

function checkClobbers(clobbers: string[], st: ParseState, line: number, cconvId: string | null) {
  for (const c of clobbers) {
    if (!PHYS.test(c)) {
      st.diags.push(diag("FORMAT_CORRUPT", `clobber must name a physical register, got '${c}'`, { line }, c));
    } else if (!classOf(c, st)) {
      st.diags.push(diag("SEMANTIC_UNSAT", `clobbered register ${c} is not declared in any register class`, { line }, c));
    }
  }
  if (cconvId) {
    const cc = st.conventions.get(cconvId);
    if (cc && clobbers.length > 0) {
      for (const c of clobbers) {
        if (!cc.callerSaved.includes(c) && !cc.argumentRegs.includes(c) && !cc.returnRegs.includes(c)) {
          st.diags.push(
            diag("SEMANTIC_UNSAT", `clobbered ${c} is not caller-saved/arg/return under cconv ${cconvId}`, { line }, c)
          );
        }
      }
    }
  }
}

function mkInstr(
  seq: number,
  index: number,
  blockId: string,
  opcode: string,
  defs: Operand[],
  uses: Operand[],
  clobbers: string[],
  isMove: boolean,
  precolors: Instr["precolors"],
  text: string,
  line: number
): Instr {
  return {
    id: `i${seq}`,
    index,
    blockId,
    opcode,
    defs,
    uses,
    clobbers,
    phiUses: [],
    isMove,
    precolors,
    text,
    line
  };
}

function pushInstr(block: Block, instr: Instr, all: Instr[]) {
  block.instrIds.push(instr.id);
  all.push(instr);
}

// ---------------------------------------------------------------------------
// CFG resolution, semantic checks, loop detection
// ---------------------------------------------------------------------------

function resolveFunc(fb: FuncBuild, st: ParseState, idx: number): Func {
  const labelToBlock = new Map<string, Block>();
  for (const b of fb.blocks) labelToBlock.set(b.label, b);

  // Resolve terminator successors; fall-through for blocks without terminator.
  for (let bi = 0; bi < fb.blocks.length; bi++) {
    const b = fb.blocks[bi]!;
    const lastId = b.instrIds[b.instrIds.length - 1];
    const last = lastId ? fb.instrs.find((i) => i.id === lastId) : undefined;
    if (last?.terminator) {
      for (const lab of last.terminator.successors) {
        const tb = labelToBlock.get(lab);
        if (!tb) {
          st.diags.push(diag("SEMANTIC_UNSAT", `block ${b.id} jumps to undefined label '${lab}'`, { line: last.line, blockId: b.id }, lab));
        } else {
          b.successorIds.push(tb.id);
        }
      }
    } else if (bi < fb.blocks.length - 1) {
      b.successorIds.push(fb.blocks[bi + 1]!.id);
    }
  }

  // phi predecessor labels must exist and be actual predecessors.
  for (const ins of fb.instrs) {
    if (ins.opcode !== "phi") continue;
    const block = fb.blocks.find((b) => b.id === ins.blockId)!;
    const labels = new Set(ins.phiUses.map((p) => p.predBlockId));
    for (const lab of labels) {
      const pb = labelToBlock.get(lab);
      if (!pb) {
        st.diags.push(diag("SEMANTIC_UNSAT", `phi at ${ins.id} references undefined predecessor label '${lab}'`, { line: ins.line, blockId: block.id }, lab));
      } else if (!block.successorIds.includes(pb.id) && !pb.successorIds.includes(block.id)) {
        st.diags.push(diag("SEMANTIC_UNSAT", `phi at ${ins.id}: block '${lab}' is not a predecessor of ${block.id}`, { line: ins.line, blockId: block.id }, lab));
      }
    }
  }

  for (const b of fb.blocks) {
    for (const s of b.successorIds) {
      const sb = fb.blocks.find((x) => x.id === s)!;
      if (!sb.predecessorIds.includes(b.id)) sb.predecessorIds.push(b.id);
    }
  }

  if (fb.blocks.length === 0) {
    st.diags.push(diag("INPUT_INCOMPLETE", `function ${fb.name} has no basic blocks`, { line: fb.line }));
  }

  const { depths, backEdges } = naturalLoopDepths(fb.blocks);

  return {
    id: `f${idx}-${fb.name}`,
    name: fb.name,
    blocks: fb.blocks,
    instrs: fb.instrs,
    entryBlockId: fb.blocks[0]?.id ?? "b0",
    loopDepthByIndex: fb.instrs.map((i) => depths[i.blockId] ?? 0),
    backEdges
  };
}

/**
 * Natural loops via dominators: for every back edge h<-t (h dominates t),
 * loop body = blocks that can reach t without passing h; depth is the count
 * of enclosing natural loops. Basis recorded in the snapshot.
 */
function naturalLoopDepths(blocks: Block[]): {
  depths: Record<string, number>;
  backEdges: { from: string; to: string }[];
} {
  const n = blocks.length;
  const byId = new Map(blocks.map((b, i) => [b.id, i]));
  const succ = blocks.map((b) => b.successorIds.map((s) => byId.get(s)!).filter((i) => i !== undefined));
  const pred = blocks.map((b) => b.predecessorIds.map((s) => byId.get(s)!));
  const entry = 0;

  // Dominators (iterative fixed point).
  const dom: Set<number>[] = blocks.map((_, i) => (i === entry ? new Set([entry]) : new Set(blocks.map((_, j) => j))));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (i === entry || pred[i]!.length === 0) continue;
      let inter: Set<number> | null = null;
      for (const p of pred[i]!) {
        inter = inter === null ? new Set(dom[p]!) : new Set([...inter].filter((x) => dom[p]!.has(x)));
      }
      const next = new Set(inter!);
      next.add(i);
      if (next.size !== dom[i]!.size || [...next].some((x) => !dom[i]!.has(x))) {
        dom[i] = next;
        changed = true;
      }
    }
  }

  const backEdges: { from: string; to: string }[] = [];
  const bodies: Set<number>[] = [];
  for (let t = 0; t < n; t++) {
    for (const s of succ[t]!) {
      if (dom[t]!.has(s)) {
        backEdges.push({ from: blocks[t]!.id, to: blocks[s]!.id });
        // Natural loop body: h plus nodes reaching t without crossing h.
        const body = new Set<number>([s]);
        const stack = [t];
        while (stack.length) {
          const x = stack.pop()!;
          if (body.has(x)) continue;
          body.add(x);
          for (const p of pred[x]!) if (p !== s || x !== t) stack.push(p);
        }
        bodies.push(body);
      }
    }
  }
  const depths: Record<string, number> = {};
  for (const b of blocks) {
    const bi = byId.get(b.id)!;
    depths[b.id] = bodies.filter((body) => body.has(bi)).length;
  }
  return { depths, backEdges };
}

function semanticChecks(func: Func, st: ParseState) {
  const defSeen = new Map<string, string>(); // vreg -> first instr id
  const classByVreg = new Map<string, string>();
  const precolorByVreg = new Map<string, string>();

  const touchOperand = (o: Operand, ins: Instr) => {
    if (o.opClass === "virt") {
      if (classByVreg.has(o.ref) && classByVreg.get(o.ref) !== o.regClassId) {
        st.diags.push(
          diag("SEMANTIC_UNSAT", `vreg v${o.ref} used with conflicting classes ${classByVreg.get(o.ref)} vs ${o.regClassId}`, { line: ins.line, blockId: ins.blockId }, o.text)
        );
      }
      classByVreg.set(o.ref, o.regClassId);
    }
  };

  for (const ins of func.instrs) {
    for (const d of ins.defs) {
      touchOperand(d, ins);
      if (d.opClass === "virt") {
        if (defSeen.has(d.ref)) {
          st.diags.push(diag("SEMANTIC_UNSAT", `vreg v${d.ref} redefined at ${ins.id} (SSA violated; first def ${defSeen.get(d.ref)})`, { line: ins.line, blockId: ins.blockId }, d.text));
        }
        defSeen.set(d.ref, ins.id);
      }
    }
    for (const u of ins.uses) touchOperand(u, ins);
    for (const p of ins.phiUses) touchOperand(p.operand, ins);
    for (const pc of ins.precolors) {
      const vo = pc.operand;
      const existing = precolorByVreg.get(vo.ref);
      if (existing && existing !== pc.phys) {
        st.diags.push(
          diag("SEMANTIC_UNSAT", `precolor conflict: v${vo.ref} constrained to both ${existing} and ${pc.phys} at ${ins.id}`, { line: ins.line, blockId: ins.blockId }, vo.text)
        );
      }
      precolorByVreg.set(vo.ref, pc.phys);
    }
  }

  // Every phi-defined vreg must be used/defined consistently; every use must
  // have a dominating def. Conservative CFG-wide check plus dominance check.
  const byId = new Map(func.blocks.map((b) => [b.id, b]));
  const indexById = new Map(func.blocks.map((b, i) => [b.id, i]));
  const dom: Set<string>[] = computeDom(func);
  const defBlock = new Map<string, string>();
  for (const ins of func.instrs) for (const d of ins.defs) if (d.opClass === "virt") defBlock.set(d.ref, ins.blockId);

  const checkUse = (o: Operand, ins: Instr) => {
    if (o.opClass !== "virt") return;
    const db = defBlock.get(o.ref);
    if (!db) {
      st.diags.push(diag("SEMANTIC_UNSAT", `vreg v${o.ref} used at ${ins.id} but never defined`, { line: ins.line, blockId: ins.blockId }, o.text));
      return;
    }
    const di = indexById.get(db)!;
    const ui = indexById.get(ins.blockId)!;
    if (!dom[ui]!.has(func.blocks[di]!.id) && db !== ins.blockId) {
      st.diags.push(diag("SEMANTIC_UNSAT", `vreg v${o.ref} used at ${ins.id} is not defined on all paths`, { line: ins.line, blockId: ins.blockId }, o.text));
    }
  };
  for (const ins of func.instrs) {
    for (const u of ins.uses) checkUse(u, ins);
    for (const p of ins.phiUses) checkUse(p.operand, ins);
  }
  void byId;

  // Precolored physical register whose class differs from the vreg class.
  for (const ins of func.instrs) {
    for (const pc of ins.precolors) {
      const cls = classOf(pc.phys, st);
      const vcls = classByVreg.get(pc.operand.opClass === "virt" ? pc.operand.ref : "");
      if (cls && vcls && cls !== vcls) {
        st.diags.push(diag("SEMANTIC_UNSAT", `precolor ${pc.phys} (class ${cls}) incompatible with v${pc.operand.ref} class ${vcls} at ${ins.id}`, { line: ins.line, blockId: ins.blockId }, pc.operand.text));
      }
    }
  }
}

function computeDom(func: Func): Set<string>[] {
  const n = func.blocks.length;
  const ids = func.blocks.map((b) => b.id);
  const pred = func.blocks.map((b) => b.predecessorIds.map((p) => ids.indexOf(p)));
  const dom: Set<number>[] = func.blocks.map((_, i) => (i === 0 ? new Set([0]) : new Set(func.blocks.map((_, j) => j))));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (i === 0 || pred[i]!.length === 0) continue;
      let inter: Set<number> | null = null;
      for (const p of pred[i]!) inter = inter === null ? new Set(dom[p]!) : new Set([...inter].filter((x) => dom[p]!.has(x)));
      const next = new Set(inter!);
      next.add(i);
      if (next.size !== dom[i]!.size) {
        dom[i] = next;
        changed = true;
      }
    }
  }
  return dom.map((s) => new Set([...s].map((i) => ids[i]!)));
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

export interface ParseOutcome {
  snapshot: SourceSnapshot;
  accepted: boolean;
}

export function parseSource(originalText: string, importedAt: string): ParseOutcome {
  const st: ParseState = {
    lines: originalText.split(/\r?\n/),
    regClasses: new Map(),
    conventions: new Map(),
    diags: []
  };

  const funcs: Func[] = [];
  let i = 0;
  while (i < st.lines.length) {
    const lineNo = i + 1;
    const line = st.lines[i]!.replace(/;.*$/, "").trim();
    i++;
    if (!line) continue;

    if (line.startsWith("class ")) {
      parseClassDirective(line.slice(6).trim(), st, lineNo);
      continue;
    }
    if (line.startsWith("cconv ")) {
      parseCconvDirective(line.slice(6).trim(), st, lineNo);
      continue;
    }
    const fnM = line.match(/^function\s+(\S+)(?:\s+cconv\s+(\S+))?\s*\{?$/);
    if (fnM) {
      const name = fnM[1]!;
      const cconvId = fnM[2] ?? null;
      if (cconvId && !st.conventions.has(cconvId)) {
        st.diags.push(diag("INPUT_INCOMPLETE", `function ${name} references unknown cconv '${cconvId}'`, { line: lineNo }, cconvId));
      }
      const body: string[] = [];
      let startLine = lineNo;
      let opened = line.endsWith("{");
      if (!opened) {
        // allow "function name" followed by "{" on next line
        const peek = st.lines[i]?.replace(/;.*$/, "").trim();
        if (peek === "{") {
          opened = true;
          i++;
        }
      }
      while (i < st.lines.length) {
        const b = st.lines[i]!;
        i++;
        if (b.replace(/;.*$/, "").trim() === "}") break;
        body.push(b);
      }
      const fb = parseFunc(name, cconvId, body, startLine + 1, st);
      const func = resolveFunc(fb, st, funcs.length);
      semanticChecks(func, st);
      funcs.push(func);
      continue;
    }
    st.diags.push(diag("FORMAT_CORRUPT", `expected 'class', 'cconv' or 'function' directive, got '${line}'`, { line: lineNo }, line));
  }

  if (st.regClasses.size === 0) {
    st.diags.push(diag("INPUT_INCOMPLETE", "no register classes declared", { line: 1, column: 1 }));
  }
  if (funcs.length === 0) {
    st.diags.push(diag("INPUT_INCOMPLETE", "no functions defined", { line: 1, column: 1 }));
  }

  const accepted = !isFatal(st.diags);
  const snapshot: SourceSnapshot = {
    id: `snap-${shortHash(originalText)}`,
    format: "ra-ir",
    formatVersion: "1.0",
    importedAt,
    originalText,
    regClasses: [...st.regClasses.values()],
    conventions: [...st.conventions.values()],
    funcs,
    unconverted: [],
    parserDiagnostics: st.diags,
    coordinateBasis: [
      { kind: "instructionIndex", basis: "program-order, 0-based, per-function" },
      { kind: "edgeLiveness", basis: "CFG-edge (blockId, last-instruction-index)" },
      { kind: "loopDepth", basis: "natural-loop nesting depth, outer=1, derived from back edges" },
      { kind: "cost", basis: "weighted-spill-cost = sum(useCost*10^loopDepth + defCost*10^loopDepth)" },
      { kind: "degree", basis: "interference-edge count restricted to same register class" }
    ]
  };
  return { snapshot, accepted };
}

export { sortVregs };
export type { DiagnosticError };
