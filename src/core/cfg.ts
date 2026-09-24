import type { ProgramMaterial } from "./types.js";

export interface CfgInfo {
  /** label -> successor labels (canonical sorted for determinism). */
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
  /** blocks that are loop headers. */
  headers: Set<string>;
  /** back edges: [tail, header]. */
  backEdges: Array<[string, string]>;
  /** natural-loop nesting depth per block (coordinate basis: natural loops). */
  loopDepth: Map<string, number>;
  /** blocks inside each header's natural loop. */
  loopBody: Map<string, Set<string>>;
}

export function analyzeCfg(program: ProgramMaterial): CfgInfo {
  const labels = program.blocks.map((b) => b.label);
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const l of labels) {
    succ.set(l, []);
    pred.set(l, []);
  }
  for (const b of program.blocks) {
    const targets = b.successors.filter((s) => labels.includes(s));
    succ.set(b.label, [...new Set(targets)].sort());
    for (const t of targets) pred.get(t)!.push(b.label);
  }
  for (const [k, v] of pred) pred.set(k, [...new Set(v)].sort());

  // Fall-through edges: if a block ends without an explicit terminator,
  // connect it to the next block in original order.
  for (let i = 0; i < program.blocks.length; i++) {
    const b = program.blocks[i];
    const last = program.instructions[b.end - 1];
    const terminates = last && (last.op === "jmp" || last.op === "br" || last.op === "ret");
    if (!terminates && i + 1 < program.blocks.length) {
      const next = program.blocks[i + 1].label;
      if (!succ.get(b.label)!.includes(next)) succ.get(b.label)!.push(next);
      if (!pred.get(next)!.includes(b.label)) pred.get(next)!.push(b.label);
    }
  }

  const dom = computeDominators(labels, succ, program.entry);
  const backEdges: Array<[string, string]> = [];
  const headers = new Set<string>();
  for (const [tail, ts] of succ) {
    for (const h of ts) {
      if (dom.get(tail)?.has(h)) {
        backEdges.push([tail, h]);
        headers.add(h);
      }
    }
  }

  const loopBody = new Map<string, Set<string>>();
  for (const [, h] of backEdges) {
    const body = loopBody.get(h) ?? new Set<string>([h]);
    // walk backwards from tail collecting predecessors
    const tails = backEdges.filter(([, hh]) => hh === h).map(([t]) => t);
    const stack = [...tails];
    while (stack.length) {
      const n = stack.pop()!;
      if (body.has(n)) continue;
      body.add(n);
      for (const p of pred.get(n) ?? []) if (!body.has(p)) stack.push(p);
    }
    body.add(h);
    loopBody.set(h, body);
  }

  const loopDepth = new Map<string, number>();
  for (const l of labels) loopDepth.set(l, 0);
  for (const [, body] of loopBody) {
    for (const n of body) loopDepth.set(n, (loopDepth.get(n) ?? 0) + 1);
  }

  return { succ, pred, headers, backEdges, loopDepth, loopBody };
}

/** Dominator sets via iterative dataflow (deterministic label iteration). */
function computeDominators(
  labels: string[],
  succ: Map<string, string[]>,
  entry: string,
): Map<string, Set<string>> {
  const dom = new Map<string, Set<string>>();
  const all = new Set(labels);
  for (const l of labels) dom.set(l, new Set(all));
  dom.set(entry, new Set([entry]));
  const order = labels;
  let changed = true;
  const predsOf = (l: string) => {
    const ps: string[] = [];
    for (const [n, ts] of succ) if (ts.includes(l)) ps.push(n);
    return ps;
  };
  while (changed) {
    changed = false;
    for (const l of order) {
      if (l === entry) continue;
      const preds = predsOf(l);
      let inter: Set<string> | null = null;
      for (const p of preds) {
        const d = dom.get(p)!;
        if (!inter) inter = new Set(d);
        else inter = new Set([...(inter as Set<string>)].filter((x: string) => d.has(x)));
      }
      const next = new Set<string>(inter ?? []);
      next.add(l);
      const cur = dom.get(l)!;
      const nextArr = [...next] as string[];
      if (nextArr.length !== cur.size || nextArr.some((x: string) => !cur.has(x))) {
        dom.set(l, next);
        changed = true;
      }
    }
  }
  return dom;
}
