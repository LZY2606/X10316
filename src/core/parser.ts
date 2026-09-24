import type {
  Block,
  CallConvention,
  Diagnostic,
  Instruction,
  Operand,
  Precolor,
  ProgramMaterial,
  RegisterClass,
} from "./types.js";
import { Ok } from "./types.js";
import { diag, CODES } from "./diagnostic.js";

export interface ParseResult {
  material?: ProgramMaterial;
  diagnostics: Diagnostic[];
}

// Operand syntax:  name:class        virtual
// Physical registers are declared via .precolor and referenced by $name.
const OPERAND_RE = /^([A-Za-z_$][\w$]*):([A-Za-z][\w-]*)$/;

export function parseIR(text: string, format: "regs-review-ir" | "ssa-ir" = "regs-review-ir"): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const registerClasses: RegisterClass[] = [];
  const precolors: Precolor[] = [];
  const conventions: CallConvention[] = [];
  const rawInstructions: Instruction[] = [];
  const blockByLabel = new Map<string, { order: number; start: number; end: number; successors: string[] }>();
  const knownClasses = new Set<string>();
  const knownPhysical = new Map<string, string>(); // physical -> class
  const physicalOperands = new Set<string>();

  const lines = text.split(/\r?\n/);
  let entry: string | null = null;
  let currentLabel: string | null = null;
  let instrIndex = 0;

  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const rawLine = lines[lineNo - 1];
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    if (line.startsWith(".")) {
      parseDirective(line, lineNo);
      continue;
    }
    if (line.endsWith(":")) {
      const label = line.slice(0, -1).trim();
      if (entry === null) entry = label;
      if (blockByLabel.has(label)) {
        diagnostics.push(diag(CODES.FORMAT_PARSE, `duplicate block label '${label}'`, { line: lineNo, category: "format" }));
      }
      currentLabel = label;
      blockByLabel.set(label, {
        order: blockByLabel.size,
        start: instrIndex + 1,
        end: instrIndex,
        successors: [],
      });
      continue;
    }

    const instr = parseInstruction(line, lineNo);
    instrIndex += 1;
    instr.index = instrIndex;
    rawInstructions.push(instr);
    if (currentLabel) {
      const b = blockByLabel.get(currentLabel)!;
      b.end = instrIndex;
      if (instr.op === "jmp" || instr.op === "br") {
        const targetLine = instr.text.slice(instr.op.length).trim();
      const targets = targetLine.split(/[,\s]+/).filter(Boolean);
        for (const t of targets) {
          if (!b.successors.includes(t)) b.successors.push(t);
        }
      }
    } else {
      diagnostics.push(diag(CODES.FORMAT_PARSE, `instruction outside any block`, { line: lineNo, category: "format" }));
    }
  }

  function parseDirective(line: string, lineNo: number) {
    const parts = line.split(/\s+/);
    const d = parts[0];
    const rest = line.slice(d.length).trim();
    if (d === ".class") {
      // .class gpr "general purpose" bit:32 = $t0 $t1 $t2
      const m = rest.match(/^(\S+)\s+"([^"]*)"\s+(\S+)\s*=\s*(.+)$/);
      if (!m) {
        diagnostics.push(diag(CODES.FORMAT_PARSE, `malformed .class directive`, { line: lineNo, rawValue: line, category: "format" }));
        return;
      }
      const [, id, name, width, phys] = m;
      const members = phys.split(/[,\s]+/).filter(Boolean).map((p) => p.replace(/^\$/, ""));
      registerClasses.push({ id, name, width, members });
      knownClasses.add(id);
      for (const ph of members) knownPhysical.set(ph, id);
    } else if (d === ".precolor") {
      // .precolor v0:gpr = $t0
      const m = rest.match(/^(\S+)\s*=\s*\$([A-Za-z_]\w*)$/);
      if (!m) {
        diagnostics.push(diag(CODES.FORMAT_PARSE, `malformed .precolor directive`, { line: lineNo, rawValue: line, category: "format" }));
        return;
      }
      const [, left, physical] = m;
      const om = left.match(OPERAND_RE);
      if (!om) {
        diagnostics.push(diag(CODES.FORMAT_PARSE, `precolor operand must be name:class`, { line: lineNo, rawValue: left, category: "format" }));
        return;
      }
      precolors.push({ operand: om[1], physical, registerClass: om[2] });
    } else if (d === ".convention") {
      // .convention call:g "g calls" clobbers $t0 $t1
      const m = rest.match(/^(\S+)\s+"([^"]*)"\s+clobbers\s+(.+)$/);
      if (!m) {
        diagnostics.push(diag(CODES.FORMAT_PARSE, `malformed .convention directive`, { line: lineNo, rawValue: line, category: "format" }));
        return;
      }
      const [, id, name, clobberList] = m;
      const clobbers = clobberList.split(/[,\s]+/).filter(Boolean).map((p) => p.replace(/^\$/, ""));
      conventions.push({ id, name, clobbers });
    } else if (d === ".entry") {
      entry = rest.trim();
    } else {
      diagnostics.push(diag(CODES.FORMAT_PARSE, `unknown directive '${d}'`, { line: lineNo, rawValue: line, category: "format" }));
    }
  }

  function parseInstruction(line: string, lineNo: number): Instruction {
    const headMatch = line.match(/^([A-Za-z_][\w.]*)\b\s*(.*)$/);
    if (!headMatch) {
      diagnostics.push(diag(CODES.FORMAT_PARSE, `cannot parse instruction`, { line: lineNo, rawValue: line, category: "format" }));
      return blank(line, lineNo);
    }
    const [, op, restRaw] = headMatch;
    const defs: Operand[] = [];
    const uses: Operand[] = [];
    let callConvention: string | undefined;
    let isPhi = op === "phi";
    let isMove = op === "move";

    let rest = restRaw.trim();
    let defPart: string | null = null;
    if (rest.includes("=")) {
      const eq = rest.indexOf("=");
      defPart = rest.slice(0, eq).trim();
      rest = rest.slice(eq + 1).trim();
    }
    if (op === "call") {
      // CALL conv uses... => defines %ret by convention? Keep explicit def.
      const firstTok = rest.split(/[,\s]+/)[0];
      if (firstTok) callConvention = firstTok.startsWith("call:") ? firstTok : `call:${firstTok}`;
      rest = rest.split(/[,\s]+/).slice(1).join(" ");
    }

    if (defPart) addOperandList(defPart, "def", lineNo);

    if (op === "jmp" || op === "br") {
      // branch targets are labels, not register operands
    } else if (op === "phi") {
      // phi: v3:gpr = [v1:gpr from L1] [v2:gpr from L2]
      for (const m of rest.matchAll(/\[\s*([^\]]+?)\s*\]/g)) {
        const inner = m[1];
        const fm = inner.match(/^(\S+)\s+from\s+([A-Za-z_]\w*)$/);
        if (!fm) {
          diagnostics.push(diag(CODES.FORMAT_PARSE, `phi use must be '[operand from label]'`, { line: lineNo, rawValue: inner, category: "format" }));
          continue;
        }
        addOperand(fm[1], "use", lineNo, fm[2]);
      }
    } else {
      addOperandList(rest, "use", lineNo);
    }

    return {
      index: 0,
      id: "",
      text: line,
      sourceLine: lineNo,
      op,
      defs,
      uses,
      callConvention,
      isPhi,
      isMove,
    };

    function addOperandList(list: string, kind: "def" | "use", ln: number) {
      for (const tok of list.split(",").map((s) => s.trim()).filter(Boolean)) {
        addOperand(tok, kind, ln, undefined);
      }
    }

    function addOperand(tok: string, kind: "def" | "use", ln: number, edge?: string) {
      const isPhysical = tok.startsWith("$");
      const bare = tok.replace(/^\$/, "");
      const m = bare.match(OPERAND_RE);
      let cls = "";
      let name = bare;
      if (m) {
        name = m[1];
        cls = m[2];
      } else if (isPhysical && knownPhysical.has(bare)) {
        name = bare;
        cls = knownPhysical.get(bare)!;
        physicalOperands.add(bare);
      } else {
        diagnostics.push(
          diag(CODES.FORMAT_PARSE, `operand '${tok}' is not name:class and is not a known physical register`, {
            line: ln,
            operand: tok,
            rawValue: tok,
            category: "format",
          }),
        );
      }
      if (cls && !knownClasses.has(cls)) {
        diagnostics.push(
          diag(CODES.SEMANTIC_UNKNOWN_CLASS, `unknown register class '${cls}'`, {
            line: ln,
            operand: tok,
            category: "semantic",
            rawValue: tok,
          }),
        );
      }
      const operand: Operand = { kind, text: tok, registerClass: cls, edge };
      if (kind === "def") defs.push(operand);
      else uses.push(operand);
    }
  }

  function blank(line: string, lineNo: number): Instruction {
    return { index: 0, id: "", text: line, sourceLine: lineNo, op: "", defs: [], uses: [] };
  }

  // ---- semantic validation --------------------------------------------------
  if (registerClasses.length === 0) {
    diagnostics.push(diag(CODES.FORMAT_MISSING, `no register classes declared`, { category: "format" }));
  }
  if (rawInstructions.length === 0) {
    diagnostics.push(diag(CODES.FORMAT_MISSING, `no instructions found`, { category: "format" }));
  }
  for (const p of precolors) {
    if (!knownClasses.has(p.registerClass)) {
      diagnostics.push(diag(CODES.SEMANTIC_UNKNOWN_CLASS, `precolor references unknown class '${p.registerClass}'`, { operand: p.operand, category: "semantic" }));
    }
    const cls = registerClasses.find((c) => c.id === p.registerClass);
    if (cls && !cls.members.includes(p.physical)) {
      diagnostics.push(diag(CODES.SEMANTIC_UNKNOWN_PHYS, `precolor physical '$${p.physical}' not in class '${p.registerClass}'`, { operand: p.operand, rawValue: p.physical, category: "semantic" }));
    }
  }
  for (const c of conventions) {
    for (const ph of c.clobbers) {
      if (!knownPhysical.has(ph)) {
        diagnostics.push(diag(CODES.SEMANTIC_UNKNOWN_PHYS, `convention '${c.id}' clobbers unknown physical '$${ph}'`, { rawValue: ph, category: "semantic" }));
      }
    }
  }

  // blocks / edges / phi predecessors
  const blocks: Block[] = [];
  for (const [label, b] of blockByLabel) {
    blocks.push({
      id: `b${b.order}`,
      label,
      order: b.order,
      start: b.start,
      end: b.end,
      successors: b.successors,
    });
    for (const s of b.successors) {
      if (!blockByLabel.has(s)) {
        diagnostics.push(diag(CODES.SEMANTIC_UNKNOWN_BLOCK, `edge targets unknown block '${s}'`, { block: label, category: "semantic" }));
      }
    }
  }
  blocks.sort((x, y) => x.order - y.order);

  for (const ins of rawInstructions) {
    ins.id = `i${ins.index}`;
    for (const u of ins.uses) {
      if (u.edge !== undefined && !blockByLabel.has(u.edge)) {
        diagnostics.push(diag(CODES.SEMANTIC_PHI_EDGE, `phi use comes from unknown predecessor '${u.edge}'`, { instruction: ins.index, operand: u.text, category: "semantic" }));
      }
    }
  }
  if (!entry || !blockByLabel.has(entry)) {
    diagnostics.push(diag(CODES.FORMAT_MISSING, `no valid entry block`, { category: "format" }));
  }

  const hasError = diagnostics.some((d) => d.severity === "error");
  if (hasError) return { diagnostics };

  const material: ProgramMaterial = {
    format,
    formatVersion: "v1",
    registerClasses,
    precolors,
    conventions,
    instructions: rawInstructions,
    blocks,
    entry: entry!,
  };
  return { material, diagnostics };
}
