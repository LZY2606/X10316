import type { ProgramMaterial, InterferenceEdge } from "./types.js";
import { pairId } from "./identity.js";
import type { LivenessResult } from "./liveness.js";

export interface InterferenceGraph {
  /** node -> adjacent nodes (symmetric). */
  adj: Map<string, Set<string>>;
  edges: InterferenceEdge[];
  edgeById: Map<string, InterferenceEdge>;
}

export function buildInterference(program: ProgramMaterial, live: LivenessResult): InterferenceGraph {
  const adj = new Map<string, Set<string>>();
  const edgeMap = new Map<string, InterferenceEdge>();
  const ensure = (n: string) => {
    if (!adj.has(n)) adj.set(n, new Set());
    return adj.get(n)!;
  };
  for (const n of live.nodeClass.keys()) ensure(n);

  function add(a: string, b: string, reasonCode: string, reason: string, at: string) {
    if (a === b) return;
    const ca = live.nodeClass.get(a);
    const cb = live.nodeClass.get(b);
    // Different register classes never interfere: they use disjoint hardware.
    if (ca && cb && ca !== cb) return;
    const id = pairId(a, b);
    if (!edgeMap.has(id)) {
      const [x, y] = id.split("|");
      const edge: InterferenceEdge = { id, a: x, b: y, reason, reasonCode, at };
      edgeMap.set(id, edge);
    }
    ensure(a).add(b);
    ensure(b).add(a);
  }

  const moveAt = new Map<number, { src: string; dst: string }>();
  for (const ins of program.instructions) {
    if (ins.isMove && ins.defs.length === 1 && ins.uses.length === 1) {
      moveAt.set(ins.index, { dst: ins.defs[0].text, src: ins.uses[0].text });
    }
  }

  for (const ins of program.instructions) {
    const defs = ins.defs.map((d) => d.text);
    const after = live.liveAfter.get(ins.id) ?? new Set<string>();
    const at = `instr:${ins.index}`;

    // Call clobbers: every live value of the clobbered physical's class that
    // survives the call interferes with that clobbered physical register.
    const clobbers = live.callClobbers.get(ins.id);
    if (clobbers) {
      for (const phys of clobbers) {
        ensure(phys);
        for (const v of after) {
          const cv = live.nodeClass.get(v);
          const cp = live.nodeClass.get(phys) ?? classOfPhysical(program, phys);
          if (cv && cp && cv !== cp) continue;
          add(v, phys, "call-clobber", `live across call clobbering ${phys}`, at);
        }
      }
    }

    // Standard def/live-after interference.
    for (const d of defs) {
      for (const v of after) {
        if (v === d) continue;
        // Move exception: dst does not interfere with src of its own move.
        const mv = moveAt.get(ins.index);
        if (mv && d === mv.dst && v === mv.src) {
          add(d, v, "move-related", `move dst/src at i${ins.index} (coalescing candidate, no hard conflict)`, at);
          continue;
        }
        add(d, v, "def-liveafter", `def of ${d} while ${v} live`, at);
      }
    }

    // Defs of the same instruction interfere with one another.
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        add(defs[i], defs[j], "same-instr-def", "parallel defs", at);
      }
    }
  }

  // Phi edge interference: each edge operand is live on pred->block. Operands
  // live on DIFFERENT predecessor edges do not mutually interfere; but an edge
  // operand interferes with anything live-out of that predecessor.
  for (const [edgeKey, ops] of live.phiEdgeLive) {
    for (const op of ops) {
      const predLabel = edgeKey.split("->")[0];
      const out = live.liveOut.get(predLabel) ?? new Set<string>();
      for (const v of out) add(op, v, "phi-edge", `phi use live on edge ${edgeKey}`, `edge:${edgeKey}`);
    }
    // If a block supplies two edge operands simultaneously, they coexist.
    const arr = [...ops];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) add(arr[i], arr[j], "phi-edge-sameedge", `co-live on ${edgeKey}`, `edge:${edgeKey}`);
  }

  // Fixed-color precolor constraints: two nodes pinned to the same physical
  // register hard-interfere (they cannot share). Different colors => no edge.
  const byColor = new Map<string, string[]>();
  for (const [node, phys] of live.fixedColor) {
    const cls = live.nodeClass.get(node);
    if (!cls) continue;
    const key = `${cls}:${phys}`;
    const list = byColor.get(key) ?? [];
    list.push(node);
    byColor.set(key, list);
  }
  for (const [, list] of byColor) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        add(list[i], list[j], "precolor-same-color", `both pinned to the same physical register`, "precolor");
      }
    }
  }

  const edges = [...edgeMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { adj, edges, edgeById: edgeMap };
}

function classOfPhysical(program: ProgramMaterial, physText: string): string | undefined {
  const name = physText.replace(/^\$/, "");
  for (const c of program.registerClasses) if (c.members.includes(name)) return c.id;
  return undefined;
}
