import type { Block, Program, Quantity } from './types';

// 活跃性分析：phi 使用按前驱边计入活跃性（edge use），
// 循环权重 = loopWeightBase^loopDepth，作为溢出代价的坐标基准。

export interface LivenessResult {
  liveIn: Map<string, Set<string>>;
  liveOut: Map<string, Set<string>>;
  edgeUses: Map<string, Set<string>>;        // "pred->succ" -> 该边上 phi 使用的 vreg
  instrLiveAfter: Map<string, Set<string>>;  // 指令 id -> 指令之后的活跃集
  loopDepth: Map<string, number>;
  blockWeight: Map<string, Quantity>;        // 含单位与基准
}

export function computeLoopDepths(program: Program): Map<string, number> {
  const depth = new Map<string, number>();
  const blocks = new Map(program.blocks.map((b) => [b.id, b]));
  for (const b of program.blocks) depth.set(b.id, b.loopDepth ?? 0);
  // 若全部显式标注则尊重标注；否则用回边推导自然循环。
  if (program.blocks.every((b) => b.loopDepth !== undefined)) return depth;

  // DFS 找回边（指向祖先的边）
  const color = new Map<string, number>();
  const loops: Set<string>[] = [];
  const dfs = (id: string) => {
    color.set(id, 1);
    for (const s of blocks.get(id)?.successors ?? []) {
      const c = color.get(s) ?? 0;
      if (c === 0) dfs(s);
      else if (c === 1) loops.push(naturalLoop(blocks, id, s)); // 回边 id->s
    }
    color.set(id, 2);
  };
  if (blocks.has(program.entry)) dfs(program.entry);
  for (const loop of loops) {
    for (const id of loop) {
      if (!blocks.get(id) || blocks.get(id)!.loopDepth !== undefined) continue;
      depth.set(id, (depth.get(id) ?? 0) + 1);
    }
  }
  return depth;
}

function naturalLoop(blocks: Map<string, Block>, tail: string, header: string): Set<string> {
  const loop = new Set<string>([header]);
  const stack = [tail];
  // 反向 CFG
  const preds = new Map<string, string[]>();
  for (const b of blocks.values()) for (const s of b.successors) {
    (preds.get(s) ?? preds.set(s, []).get(s)!).push(b.id);
  }
  while (stack.length) {
    const n = stack.pop()!;
    if (loop.has(n)) continue;
    loop.add(n);
    for (const p of preds.get(n) ?? []) stack.push(p);
  }
  return loop;
}

export function computeLiveness(program: Program, loopWeightBase: number): LivenessResult {
  const loopDepth = computeLoopDepths(program);
  const blockWeight = new Map<string, Quantity>();
  for (const b of program.blocks) {
    const d = loopDepth.get(b.id) ?? 0;
    blockWeight.set(b.id, {
      value: Math.pow(loopWeightBase, d),
      unit: 'exec-frequency',
      basis: `static-loop-weight(base=${loopWeightBase},depth=${d})`,
    });
  }

  const liveIn = new Map<string, Set<string>>();
  const liveOut = new Map<string, Set<string>>();
  const edgeUses = new Map<string, Set<string>>();
  for (const b of program.blocks) { liveIn.set(b.id, new Set()); liveOut.set(b.id, new Set()); }

  // phi 的边使用：succ 中 phi 在 pred 边上的操作数，计入 pred 的 liveOut（经边）
  for (const b of program.blocks) {
    for (const ins of b.instrs) {
      if (ins.op !== 'phi' || !ins.phiArgs) continue;
      for (const a of ins.phiArgs) {
        const key = `${a.pred}->${b.id}`;
        if (!edgeUses.has(key)) edgeUses.set(key, new Set());
        edgeUses.get(key)!.add(a.vreg);
      }
    }
  }

  const blockUseDef = new Map<string, { use: Set<string>; def: Set<string>; phiDefs: Set<string> }>();
  for (const b of program.blocks) {
    const use = new Set<string>(); const def = new Set<string>(); const phiDefs = new Set<string>();
    for (const ins of b.instrs) {
      if (ins.op === 'phi') { for (const d of ins.defs) { phiDefs.add(d); def.add(d); } continue; }
      for (const u of ins.uses) if (!def.has(u)) use.add(u);
      for (const d of ins.defs) def.add(d);
    }
    blockUseDef.set(b.id, { use, def, phiDefs });
  }

  // 迭代数据流（按块 id 排序处理，保证等价输入得到稳定顺序）
  const order = [...program.blocks].map((b) => b.id).sort();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      const b = program.blocks.find((x) => x.id === id)!;
      const ud = blockUseDef.get(id)!;
      const out = new Set<string>();
      for (const s of b.successors) {
        const eu = edgeUses.get(`${id}->${s}`);
        if (eu) for (const v of eu) out.add(v); // phi 边使用计入本块出口
        const succUd = blockUseDef.get(s);
        for (const v of liveIn.get(s) ?? []) {
          if (succUd && succUd.phiDefs.has(v)) continue; // phi 定义不穿透到前驱
          out.add(v);
        }
      }
      const inn = new Set<string>(ud.use);
      for (const v of out) if (!ud.def.has(v)) inn.add(v);
      if (!setEq(inn, liveIn.get(id)!) || !setEq(out, liveOut.get(id)!)) {
        liveIn.set(id, inn); liveOut.set(id, out); changed = true;
      }
    }
  }

  // 指令级 liveAfter（从块尾向前）
  const instrLiveAfter = new Map<string, Set<string>>();
  for (const b of program.blocks) {
    let live = new Set(liveOut.get(b.id));
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      const ins = b.instrs[i];
      instrLiveAfter.set(ins.id, new Set(live));
      for (const d of ins.defs) live.delete(d);
      if (ins.op === 'phi') continue; // phi 的使用在边上，不在块内
      for (const u of ins.uses) live.add(u);
    }
  }

  return { liveIn, liveOut, edgeUses, instrLiveAfter, loopDepth, blockWeight };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
