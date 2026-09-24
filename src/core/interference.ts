/**
 * Interference graph, built strictly per register class — nodes of
 * different classes never share an edge and are never merged.
 */
import { PhysReg, Program, RegClassId, VReg } from "./ir.js";
import { LivenessResult } from "./liveness.js";

export interface Move {
  id: string;
  instrId: string;
  src: VReg;
  dst: VReg;
  class: RegClassId | null; // null => cross-class move, never coalesceable
  coalesceable: boolean;
}

export interface Graph {
  run: number;
  /** node id: "v:<vreg>" or "p:<phys>" */
  nodes: string[];
  /** edges as sorted "a|b" keys */
  edges: string[];
  adj: Record<string, string[]>;
  moves: Move[];
  /** forced colors from precoloring: nodeId -> phys */
  precolored: Record<string, PhysReg>;
}

export const vnode = (v: VReg) => `v:${v}`;
export const pnode = (r: PhysReg) => `p:${r}`;
export const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function buildGraph(p: Program, live: LivenessResult): Graph {
  const vregClass = new Map<VReg, RegClassId>();
  for (const ins of p.instructions) {
    for (const d of ins.defs) if (!vregClass.has(d.v)) vregClass.set(d.v, d.class);
    for (const u of ins.uses) if (!vregClass.has(u.v)) vregClass.set(u.v, u.class);
  }
  for (const phi of p.phis) {
    if (!vregClass.has(phi.dst.v)) vregClass.set(phi.dst.v, phi.dst.class);
    for (const inc of phi.incoming) {
      // incoming vregs carry the phi dst's class by SSA convention; keep their own if known
      if (!vregClass.has(inc.v)) vregClass.set(inc.v, phi.dst.class);
    }
  }

  const physClass = new Map<PhysReg, RegClassId>();
  for (const c of p.classes) for (const r of c.regs) physClass.set(r, c.id);

  const adj = new Map<string, Set<string>>();
  const addNode = (n: string) => {
    if (!adj.has(n)) adj.set(n, new Set());
  };
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    addNode(a);
    addNode(b);
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  for (const c of p.classes) for (const r of c.regs) addNode(pnode(r));
  for (const v of vregClass.keys()) addNode(vnode(v));

  const sameClassNodes = (a: string, b: string): boolean => {
    const clsOf = (n: string) =>
      n.startsWith("v:") ? vregClass.get(n.slice(2)) : physClass.get(n.slice(2));
    const ca = clsOf(a);
    const cb = clsOf(b);
    return ca !== undefined && ca === cb;
  };
  const link = (a: string, b: string) => {
    if (sameClassNodes(a, b)) addEdge(a, b);
  };

  const moves: Move[] = [];
  for (const ins of p.instructions) {
    const after = live.liveAfter[ins.id] ?? [];
    const before = live.liveBefore[ins.id] ?? [];
    if (ins.isMove && ins.defs.length === 1 && ins.uses.length === 1) {
      const src = ins.uses[0];
      const dst = ins.defs[0];
      const crossClass = src.class !== dst.class;
      moves.push({
        id: `mv:${ins.id}`,
        instrId: ins.id,
        src: src.v,
        dst: dst.v,
        class: crossClass ? null : src.class,
        coalesceable: !crossClass,
      });
      // move: dst interferes with live-after minus the move source
      for (const lv of after) if (lv !== src.v) link(vnode(dst.v), vnode(lv));
    } else {
      for (const d of ins.defs) for (const lv of after) link(vnode(d.v), vnode(lv));
    }
    // clobbers (e.g. call): phys reg interferes with everything live across
    const across = new Set([...before, ...after]);
    for (const cl of ins.clobbers) for (const lv of across) link(pnode(cl), vnode(lv));
  }

  // phi destinations of a block are simultaneously defined
  const phisByBlock = new Map<string, typeof p.phis>();
  for (const phi of p.phis) {
    const arr = phisByBlock.get(phi.block) ?? [];
    arr.push(phi);
    phisByBlock.set(phi.block, arr);
  }
  for (const [blk, phis] of phisByBlock) {
    const dsts = phis.map((x) => x.dst.v);
    for (let i = 0; i < dsts.length; i++)
      for (let j = i + 1; j < dsts.length; j++) link(vnode(dsts[i]), vnode(dsts[j]));
    for (const lv of live.liveIn[blk] ?? []) {
      for (const d of dsts) if (lv !== d) link(vnode(d), vnode(lv));
    }
  }

  // precolor: vreg pinned to phys -> interferes with every OTHER phys of its class
  const precolored: Record<string, PhysReg> = {};
  for (const pc of p.precolors) {
    const cls = vregClass.get(pc.v);
    if (!cls) continue;
    precolored[vnode(pc.v)] = pc.phys;
    const clsDecl = p.classes.find((c) => c.id === cls)!;
    for (const r of clsDecl.regs) if (r !== pc.phys) addEdge(vnode(pc.v), pnode(r));
  }

  const nodes = [...adj.keys()].sort();
  const edges: string[] = [];
  for (const a of nodes) for (const b of adj.get(a)!) if (a < b) edges.push(`${a}|${b}`);
  edges.sort();
  const adjRec: Record<string, string[]> = {};
  for (const n of nodes) adjRec[n] = [...adj.get(n)!].sort();

  return { run: live.run, nodes, edges, adj: adjRec, moves, precolored };
}
