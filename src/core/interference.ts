import type { Program } from './types';
import type { LivenessResult } from './liveness';

// 干涉图：不同 register class 的节点之间绝不连边（不错误合并）。
// 预着色 vreg 与同类的所有其他 preg 连边（固定颜色）；clobber 的 preg
// 与跨越该点的所有活跃值连边。

export interface InterferenceGraph {
  nodes: Set<string>;
  nodeClass: Map<string, string>;          // node -> register class 名
  adj: Map<string, Set<string>>;
  precolored: Map<string, string>;         // vreg/preg -> preg（preg 映射到自身）
}

export function buildInterference(program: Program, live: LivenessResult): InterferenceGraph {
  const g: InterferenceGraph = { nodes: new Set(), nodeClass: new Map(), adj: new Map(), precolored: new Map() };
  const pregClass = new Map<string, string>();
  for (const c of program.registerClasses) for (const r of c.regs) pregClass.set(r, c.name);

  const addNode = (n: string, cls: string) => {
    if (!g.nodes.has(n)) { g.nodes.add(n); g.adj.set(n, new Set()); g.nodeClass.set(n, cls); }
  };
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    const ca = g.nodeClass.get(a); const cb = g.nodeClass.get(b);
    if (ca && cb && ca !== cb) return; // 不同 register class 不错误合并
    g.adj.get(a)!.add(b); g.adj.get(b)!.add(a);
  };

  for (const [name, info] of Object.entries(program.vregs)) addNode(name, info.cls);
  for (const c of program.registerClasses) for (const r of c.regs) { addNode(r, c.name); g.precolored.set(r, r); }

  // 预着色：vreg -> preg，固定颜色（与同类其他 preg 连边）
  for (const [v, preg] of Object.entries(program.precolors)) {
    g.precolored.set(v, preg);
    const cls = g.nodeClass.get(v)!;
    for (const c of program.registerClasses) {
      if (c.name !== cls) continue;
      for (const r of c.regs) if (r !== preg) addEdge(v, r);
    }
  }

  for (const b of program.blocks) {
    for (const ins of b.instrs) {
      const after = live.instrLiveAfter.get(ins.id) ?? new Set<string>();
      // defs 与 liveAfter 干涉；move 的 src/dst 不连边（保留 coalescing 机会）
      for (const d of ins.defs) {
        for (const l of after) {
          if (ins.isMove && ins.uses.includes(l)) continue;
          addEdge(d, l);
        }
      }
      // 调用 clobber：clobber 的 preg 与跨越该点的所有活跃值干涉
      for (const preg of ins.clobbers ?? []) {
        for (const l of after) addEdge(preg, l);
        for (const d of ins.defs) addEdge(preg, d);
      }
    }
  }
  return g;
}

export function degrees(g: InterferenceGraph): Map<string, number> {
  const d = new Map<string, number>();
  for (const n of g.nodes) d.set(n, g.adj.get(n)?.size ?? 0);
  return d;
}
