import './style.css';

type State = any;
let state: State = null;
let selectedEventId: string | null = null;
let graphClass: Record<number, string> = {};
let iterIndex: Record<number, number> = {};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return res.json();
}

async function refresh(keepEvent?: boolean) {
  const qs = keepEvent && selectedEventId ? `?eventId=${encodeURIComponent(selectedEventId)}` : '';
  const r = await api(`/api/state${qs}`);
  state = r.state;
  if (!keepEvent) selectedEventId = state.selected.event?.id ?? null;
  render();
}

function statusTag(status: string | null): string {
  if (!status) return '';
  const cls = status === 'ok' ? 'ok' : status === 'budget_exhausted' ? 'budget' : 'err';
  return `<span class="tag ${cls}">${esc(status)}</span>`;
}

function kindTag(kind: string, extra = ''): string {
  const cls = kind === 'decision' ? (extra === 'accept' ? 'accept' : 'reject') : '';
  const label: Record<string, string> = {
    import_source: '导入', edit_source: '源改动', revise_parameters: '参数修订',
    compute: '计算', decision: extra === 'accept' ? '接受' : '否定', fork: '分支',
  };
  return `<span class="tag ${cls}">${label[kind] ?? kind}</span>`;
}

function renderTimeline(): string {
  const groups = new Map<string, any[]>();
  for (const e of state.events) {
    if (!groups.has(e.branchId)) groups.set(e.branchId, []);
    groups.get(e.branchId)!.push(e);
  }
  return state.branches
    .map((b: any) => {
      const evs = (groups.get(b.id) ?? []).map((e: any) => {
        const active = selectedEventId === e.id ? ' active' : '';
        const extra = e.verdict ?? '';
        return `<div class="event${active}" data-event="${esc(e.id)}">
          <div><span class="seq">#${e.seq}</span>${kindTag(e.kind, extra)}${statusTag(e.status)}</div>
          <div>${esc(e.summary)}</div>
          <div class="nb mono">${esc(e.id)} · v${e.paramVersion}</div>
        </div>`;
      }).join('');
      return `<div class="branch-group"><h3>⎇ ${esc(b.name)}</h3>${evs}</div>`;
    })
    .join('');
}


function renderMaterials(m: any): string {
  if (!m) return '<div class="nb">当前事件之前没有材料。</div>';
  if (m.parseFailure) {
    return `<div class="diag-error">材料解析失败：${m.parseFailure.map((d: any) => `第${d.line}行 ${esc(d.message)}`).join('；')}</div>`;
  }
  const classRows = m.classes.map((c: any) =>
    `<tr><td class="mono">${esc(c.name)}</td><td>${c.regs.map((r: string) => `<span class="chip phys">${r}</span>`).join('')}</td></tr>`).join('');
  const pre = m.precolors.map((p: any) =>
    `<span class="chip">${esc(p.vreg)} → <b style="color:var(--phys)">${esc(p.phys)}</b> <span class="nb">@line ${p.line}</span></span>`).join(' ');
  const instrRows = m.instructions.map((i: any) => {
    const du = `${i.defs.map((d: any) => `${esc(d.name)}:${esc(d.cls)}`).join(' ') || '—'}`;
    const uses = i.uses.map((u: any) => esc(u.name)).join(' ') ||
      (i.phiUses.length ? i.phiUses.map((p: any) => `${esc(p.name)}@${esc(p.pred)}`).join(' ') : '—');
    const flags = [i.call ? `clobber ${i.clobbers.join(' ')}` : '', i.move ? 'move' : ''].filter(Boolean).join(' · ');
    return `<tr><td class="mono">${esc(i.id)}</td><td class="mono">@${esc(i.block)}</td>
      <td class="mono">${esc(du)}</td><td class="mono">${esc(uses)}</td>
      <td class="mono">${esc(i.op)}</td><td class="nb mono">${esc(flags)}</td></tr>`;
  }).join('');
  return `
  <div class="grid">
    <div>
      <h2>寄存器类 / 调用约定</h2>
      <table><tr><th>class</th><th>物理寄存器（K）</th></tr>${classRows}</table>
      <h2 style="margin-top:10px">预着色 / clobber / move</h2>
      <div>${pre || '<span class="nb">无</span>'}</div>
      <div class="nb" style="margin-top:6px">clobber 由 call 指令行携带；move 见指令表。</div>
    </div>
    <div>
      <h2>CFG</h2>
      <ul class="tight mono">${m.blocks.map((b: any) =>
        `<li>@${esc(b.name)} weight <b>${esc(b.weight.raw)}</b>${b.weight.diagnostic ? ` <span class="diag-warning">⚠ ${esc(b.weight.diagnostic)}</span>` : ''} → ${b.succs.length ? b.succs.map((s: string) => `@${esc(s)}`).join(', ') : '∅'}</li>`).join('')}</ul>
    </div>
  </div>
  <h2>原指令顺序与 def/use（不可变材料，digest <span class="mono">${esc(m.digest.slice(0, 16))}</span>）</h2>
  <table><tr><th>id</th><th>块</th><th>def:class</th><th>use / phi 边使用</th><th>op</th><th>标记</th></tr>${instrRows}</table>
  <details style="margin-top:8px"><summary class="nb">原始表示（逐字符保留）</summary><pre>${esc(m.source)}</pre></details>`;
}

function renderLiveness(result: any, iter: any): string {
  return iter.liveSets.map((bl: any) => `
    <div style="margin-bottom:8px">
      <b class="mono">@${esc(bl.block)}</b>
      <div>live-in: ${bl.liveIn.length ? bl.liveIn.map((v: string) => `<span class="chip">${esc(v)}</span>`).join('') : '<span class="nb">∅</span>'}</div>
      <div>live-out: ${bl.liveOut.length ? bl.liveOut.map((v: string) => `<span class="chip">${esc(v)}</span>`).join('') : '<span class="nb">∅</span>'}</div>
      <table><tr><th>instr</th><th>live before</th><th>live after</th></tr>
      ${bl.instrs.map((it: any) => `<tr><td class="mono">${esc(it.id)}</td>
        <td>${it.liveBefore.map((v: string) => `<span class="chip">${esc(v)}</span>`).join('') || '∅'}</td>
        <td>${it.liveAfter.map((v: string) => `<span class="chip">${esc(v)}</span>`).join('') || '∅'}</td></tr>`).join('')}
      </table>
    </div>`).join('');
}

function graphSvg(view: any, coloring: Map<string, string>): string {
  const W = 760;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2;
  const R = 120;
  const nodes = view.nodes;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n: any, idx: number) => {
    const a = (2 * Math.PI * idx) / Math.max(nodes.length, 1) - Math.PI / 2;
    const rr = n.kind === 'phys' ? R + 55 : R;
    pos.set(n.id, { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) * 0.72 });
  });
  const edges = view.edges.map(([a, b]: [string, string]) => {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) return '';
    return `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="#33415e" stroke-width="1"/>`;
  }).join('');
  const circles = nodes.map((n: any) => {
    const p = pos.get(n.id)!;
    const color = coloring.get(n.id);
    const fill = n.kind === 'phys' ? '#241b36' : color ? '#12301f' : '#101827';
    const stroke = n.kind === 'phys' ? '#b08cff' : color ? '#4cc38a' : '#5aa7ff';
    return `<g><circle cx="${p.x}" cy="${p.y}" r="15" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
      <text x="${p.x}" y="${p.y + 3.5}" text-anchor="middle" font-size="9.5" fill="#dce4f2" class="mono">${esc(n.id.replace('%', ''))}</text>
      ${color ? `<text x="${p.x}" y="${p.y + 30}" text-anchor="middle" font-size="9" fill="#4cc38a" class="mono">${esc(color)}</text>` : ''}
      <title>${esc(n.id)} degree=${n.degree}${color ? ` color=${color}` : ''}</title></g>`;
  }).join('');
  return `<svg class="graph" viewBox="0 0 ${W} ${H}">${edges}${circles}</svg>`;
}

function renderGraphs(result: any, iter: any, iterationIdx: number): string {
  const coloring = new Map<string, string>(result.coloring.map((c: any) => [c.vreg, c.color]));
  const selected = graphClass[iterationIdx] ?? iter.graphs[0]?.className;
  const view = iter.graphs.find((g: any) => g.className === selected) ?? iter.graphs[0];
  const tabs = iter.graphs.map((g: any) =>
    `<span class="tab ${g.className === view.className ? 'active' : ''}" data-graph-class="${esc(g.className)}" data-iter="${iterationIdx}">${esc(g.className)} (K=${g.k}, E=${g.edges.length})</span>`).join('');
  return `<div class="tabs">${tabs}</div>${graphSvg(view, coloring)}
    <div class="nb" style="margin-top:4px">物理寄存器为外环（紫）；绿字为最终选色。节点 id 稳定。</div>`;
}

function renderStack(iter: any): string {
  if (!iter.simplifyStack.length) return '<div class="nb">本轮无简化栈（可能直接冲突/预算终止）。</div>';
  return `<div style="display:flex;flex-direction:column-reverse;gap:3px">` +
    iter.simplifyStack.map((n: string, i: number) =>
      `<div class="chip" style="text-align:center">${i}. ${esc(n)}</div>`).join('') + `</div>`;
}

function renderColors(result: any): string {
  return `<table><tr><th>vreg（稳定身份）</th><th>类</th><th>颜色</th></tr>` +
    result.coloring.map((c: any) =>
      `<tr><td class="mono">${esc(c.vreg)}</td><td class="mono">${esc(c.cls)}</td>
       <td><span class="chip color">${esc(c.color)}</span></td></tr>`).join('') + `</table>`;
}

function renderSpill(result: any): string {
  const rows: string[] = [];
  for (const it of result.iterations) {
    if (!it.spill) continue;
    for (const c of it.spill.candidates) {
      const isVictim = it.spill.victim === c.node;
      rows.push(`<tr style="${isVictim ? 'background:#1d2c1a' : ''}">
        <td>iter ${it.index}</td><td class="mono">${esc(c.node)}</td><td>${c.degree}</td>
        <td class="mono" title="${esc(c.cost.basis ?? '')}">${esc(c.cost.raw)}</td>
        <td class="nb">${c.cost.value === null ? `<span class="diag-warning">⚠ ${esc(c.cost.diagnostic)}</span>` : (c.cost.value / Math.max(c.degree, 1)).toFixed(2)}</td>
        <td>${isVictim ? '<b class="diag-error">溢出受害者</b>' : ''} ${it.spill.tied.includes(c.node) && it.spill.tied.length > 1 ? ' <span class="tag budget">并列候选</span>' : ''}</td></tr>`);
    }
  }
  return rows.length
    ? `<table><tr><th>轮次</th><th>节点</th><th>度</th><th>代价（单位/基准悬停）</th><th>代价/度</th><th>决策</th></tr>${rows.join('')}</table>
       <div class="nb">单位 cycle；基准 = store/load 代价 × 块权重^loopExponent。无法转换的代价保留原文并附诊断，不参与决策。</div>`
    : '<div class="nb">无溢出候选。</div>';
}

function renderRewrite(result: any): string {
  if (!result.rewriteDiff.length) return '<div class="nb">无重写。</div>';
  return result.rewriteDiff.map((r: any) => `
    <div class="ev">
      <div><span class="kind">${esc(r.kind)}</span> iter ${r.iteration} — ${esc(r.summary)}</div>
      <table><tr><th>重写前</th><th>重写后</th></tr><tr>
        <td class="diff-before mono">${r.before.map((b: string) => esc(b)).join('<br>')}</td>
        <td class="diff-after mono">${r.after.map((a: string) => esc(a)).join('<br>')}</td>
      </tr></table>
    </div>`).join('');
}

function renderDomainEvents(result: any): string {
  const groups = new Map<string, any[]>();
  for (const e of result.events) {
    if (!groups.has(e.kind)) groups.set(e.kind, []);
    groups.get(e.kind)!.push(e);
  }
  return [...groups.entries()].map(([kind, evs]) => `
    <details ${['phi_edge_use_counted', 'precolor_conflict', 'class_merge_rejected', 'coalesce_failed_move_kept', 'spill_rewrite_recomputed'].includes(kind) ? 'open' : ''}>
      <summary><span class="kind">${esc(kind)}</span> × ${evs.length}</summary>
      ${evs.map((e: any) => `<div class="ev">
        <div>${esc(e.summary)}</div>
        <div class="nb mono">${esc(e.id)} · iter ${e.iteration}</div>
        <details><summary class="nb">机器可读 detail</summary><pre>${esc(JSON.stringify(e.detail, null, 2))}</pre></details>
      </div>`).join('')}
    </details>`).join('');
}

function renderMoves(result: any): string {
  if (!result.moves.length) return '<span class="nb">无 move。</span>';
  const cls = (s: string) => ({ coalesced: 'ok', kept: 'err', cross_class_kept: 'budget', pending: '' } as Record<string, string>)[s] ?? '';
  const label: Record<string, string> = {
    coalesced: '已 coalesce（move 删除）', kept: 'coalescing 失败，move 保留',
    cross_class_kept: '跨类 move，不合并，保留', pending: '待处理',
  };
  return result.moves.map((m: any) =>
    `<div class="ev"><span class="kind mono">${esc(m.instrId)}</span>
      ${esc(m.from)} → ${esc(m.to)} <span class="tag ${cls(m.status)}">${label[m.status]}</span>
      ${m.reason ? `<div class="nb">依据：${esc(m.reason)}</div>` : ''}</div>`).join('');
}

function renderDiags(result: any, materials: any): string {
  const ds = [...(result.diagnostics ?? [])];
  const elements = ds.map((d: any) =>
    `<div class="diag-${esc(d.severity)}">${d.line ? `第 ${d.line} 行: ` : ''}${esc(d.message)}</div>`);
  if (result.status !== 'ok') {
    elements.unshift(`<div class="diag-error"><b>${esc(result.status)}</b>: ${esc(result.failure ?? '')}</div>`);
  }
  return elements.length ? elements.join('') : '<span class="nb">无诊断。</span>';
}

function renderControls(): string {
  const ev = state.selected.event;
  const isCompute = ev?.kind === 'compute';
  const decisions = state.selected.decisions ?? [];
  const decisionHtml = isCompute ? `
    <div class="row">
      <input type="text" id="rationale" placeholder="决定依据（写入事件 payload）" style="flex:1">
      <button class="accept" data-act="decide" data-verdict="accept" data-target="${esc(ev.id)}">接受</button>
      <button class="reject" data-act="decide" data-verdict="reject" data-target="${esc(ev.id)}">否定</button>
    </div>` : '';
  const conflictBanner = state.selected.conflicts
    ? '<div class="diag-error" style="margin:6px 0">⚠ 该计算上存在互相冲突的人工决定（接受/否定并存），两者都已保留为独立事件。</div>' : '';
  const existing = decisions.map((d: any) =>
    `<div class="ev"><span class="tag ${d.verdict}">${d.verdict === 'accept' ? '接受' : '否定'}</span>
      <span class="nb mono">#${d.seq} ${esc(d.id)}</span>
      <div>${esc(d.rationale)}</div></div>`).join('');
  return `
  <div class="card">
    <h2>人工决定 / 参数调整 <span class="sid">接受、否定、参数修订都会生成新事件；旧事件视图不被覆盖</span></h2>
    ${conflictBanner}${decisionHtml}${existing}
    <div class="row" style="margin-top:8px">
      <label>loopExponent <input type="number" id="pe" value="${state.selected.parameters.loopExponent}" style="width:70px"></label>
      <label>maxIterations <input type="number" id="pmi" value="${state.selected.parameters.maxIterations}" style="width:70px"></label>
      <label>simplifyBudget <input type="number" id="psb" value="${state.selected.parameters.simplifyBudget}" style="width:90px"></label>
      <label>storeCost <input type="text" id="psc" value="${esc(state.selected.parameters.storeCost)}" style="width:100px"></label>
      <label>loadCost <input type="text" id="plc" value="${esc(state.selected.parameters.loadCost)}" style="width:100px"></label>
      <button data-act="param">提交参数修订</button>
      <button class="primary" data-act="compute">重新计算</button>
    </div>
  </div>
  <div class="card">
    <h2>导入 / 局部源数据改动</h2>
    <textarea id="newsource">${esc(state.selected.materials?.source ?? '')}</textarea>
    <div class="row">
      <button class="primary" data-act="import">导入为源数据改动（新版本材料）</button>
    </div>
    <div class="row">
      <button data-act="export">导出项目 JSON</button>
      <label class="button-like"><button type="button" onclick="document.getElementById('bundlefile').click()">导入项目包</button></label>
      <input type="file" id="bundlefile" accept="application/json" style="display:none">
      <button data-act="reset">重置为内置样例</button>
    </div>
    <div id="api-message" class="nb"></div>
  </div>`;
}

function renderResult(): string {
  const result = state.selected.result;
  if (!result) {
    return '<div class="card"><h2>计算视图</h2><div class="nb">该事件上没有计算结果快照。选择一个 compute 事件，或调整参数后重新计算。</div></div>';
  }
  const ii = iterIndex[state.selected.resultEventId] ?? result.iterations.length - 1;
  const iter = result.iterations[ii];
  const iterTabs = result.iterations.map((_: any, idx: number) =>
    `<span class="tab ${idx === ii ? 'active' : ''}" data-iter-tab="${idx}">第 ${idx} 轮${result.iterations[idx].spill ? ' · spill' : ''}</span>`).join('');
  return `
  <div class="card full">
    <h2>计算结果快照
      <span class="sid mono">${esc(state.selected.resultEventId)}</span>
      <span class="badge-status badge-${esc(result.status)}">${esc(result.status)}</span>
      <span class="sid">inputDigest ${esc(result.inputDigest.slice(0, 12))} · paramFp ${esc(result.paramFingerprint)}</span>
    </h2>
    <div class="tabs">${iterTabs}</div>
    ${result.failure ? `<div class="diag-error" style="margin:6px 0"><b>终止原因：</b>${esc(result.failure)}</div>` : ''}
  </div>
  <div class="card"><h2>活跃集合 <span class="sid">phi 使用按前驱边计入</span></h2>${renderLiveness(result, iter)}</div>
  <div class="card"><h2>干涉图 <span class="sid">按寄存器类分别构建</span></h2>${renderGraphs(result, iter, ii)}</div>
  <div class="card"><h2>简化栈</h2>${renderStack(iter)}</div>
  <div class="card"><h2>颜色选择</h2>${renderColors(result)}</div>
  <div class="card full"><h2>Spill 代价 <span class="sid">单位 cycle，含循环权重与代价基准</span></h2>${renderSpill(result)}</div>
  <div class="card"><h2>Move 与 Coalescing</h2>${renderMoves(result)}</div>
  <div class="card"><h2>重写前后差异</h2><div style="max-height:280px;overflow:auto">${renderRewrite(result)}</div></div>
  <div class="card full"><h2>机器可读领域事件 <span class="sid">结构化状态与可重放证据，而非纯日志</span></h2>${renderDomainEvents(result)}</div>
  <div class="card full"><h2>诊断 / 失效原因</h2>${renderDiags(result, state.selected.materials)}</div>`;
}

function render(): void {
  const sel = state.selected.event;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header>
    <h1>${esc(state.case.title ?? '寄存器冲突谱')}</h1>
    <span class="meta">${esc(state.case.caseId)} · liveness / interference / coalescing / spill 回放审阅</span>
    <span style="flex:1"></span>
    <span class="meta">事件 #${sel?.seq ?? '-'} · 参数 v${sel?.paramVersion ?? '-'} · <span class="mono">${esc(sel?.id ?? '')}</span></span>
  </header>
  <div class="layout">
    <aside>${renderTimeline()}</aside>
    <main>
      <div class="card">
        <h2>不可变材料层 <span class="sid">原指令顺序 · def/use · CFG · 寄存器类 · 预着色 · clobber · move</span></h2>
        ${renderMaterials(state.selected.materials)}
      </div>
      ${renderResult()}
      ${renderControls()}
    </main>
  </div>`;
  bindEvents();
}

function post(path: string, body: unknown): Promise<any> {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

function flash(msg: string, ok = false): void {
  const el = document.querySelector<HTMLDivElement>('#api-message');
  if (el) {
    el.style.color = ok ? 'var(--ok)' : 'var(--err)';
    el.textContent = msg;
  }
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>('[data-event]').forEach((el) => {
    el.addEventListener('click', async () => {
      selectedEventId = el.dataset.event!;
      await refresh(true);
    });
  });
  document.querySelectorAll<HTMLElement>('[data-iter-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      iterIndex[state.selected.resultEventId] = parseInt(el.dataset.iterTab!, 10);
      render();
    });
  });
  document.querySelectorAll<HTMLElement>('[data-graph-class]').forEach((el) => {
    el.addEventListener('click', () => {
      graphClass[parseInt(el.dataset.iter!, 10)] = el.dataset.graphClass!;
      render();
    });
  });

  const branchId = state.selected.event?.branchId;

  document.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', async () => {
      const act = el.dataset.act;
      if (act === 'decide') {
        const rationale = document.querySelector<HTMLInputElement>('#rationale')?.value ?? '';
        const r = await post('/api/decide', {
          branchId, onEventId: el.dataset.target, verdict: el.dataset.verdict, rationale,
        });
        if (!r.ok) return flash(r.message ?? JSON.stringify(r));
        await refresh(false);
        flash('决定已记录为新事件', true);
      } else if (act === 'param') {
        const num = (id: string) => Number(document.querySelector<HTMLInputElement>(id)!.value);
        const patch = {
          loopExponent: num('#pe'), maxIterations: num('#pmi'), simplifyBudget: num('#psb'),
          storeCost: document.querySelector<HTMLInputElement>('#psc')!.value,
          loadCost: document.querySelector<HTMLInputElement>('#plc')!.value,
        };
        const r = await post('/api/param', { branchId, patch });
        if (!('ok' in r)) return flash(r.message ?? JSON.stringify(r));
        await refresh(false);
        flash(`参数修订事件 ${r.eventId} 已创建，可再点“重新计算”`, true);
      } else if (act === 'compute') {
        const r = await post('/api/compute', { branchId });
        if (!('ok' in r)) return flash(r.message ?? JSON.stringify(r));
        await refresh(false);
        flash(`计算事件 ${r.eventId}: ${r.result.status}`, r.result.status === 'ok');
      } else if (act === 'import') {
        const source = document.querySelector<HTMLTextAreaElement>('#newsource')!.value;
        const r = await post('/api/import', { branchId, source });
        if (!r.ok) return flash((r.diagnostics ?? []).map((d: any) => `第${d.line}行: ${d.message}`).join('\n') || r.message);
        await refresh(false);
        flash(`新材料版本 ${r.materialsId}，可重新计算`, true);
      } else if (act === 'export') {
        const r = await api('/api/export');
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${state.case.caseId}-export.json`;
        a.click();
      } else if (act === 'reset') {
        const r = await post('/api/reset', {});
        if (r.ok) {
          selectedEventId = null;
          state = r.state;
          render();
        }
      }
    });
  });

  const file = document.querySelector<HTMLInputElement>('#bundlefile');
  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const bundle = JSON.parse(await f.text());
      const r = await post('/api/import-bundle', bundle);
      if (!r.ok) return flash(r.message);
      await refresh(false);
      flash(`导入完成：events ${r.imported.events}，跳过 ${r.skipped}`, true);
    } catch (e) {
      flash(`包解析失败: ${String(e)}`);
    }
  });
}

refresh(false).catch((e) => {
  document.querySelector('#app')!.innerHTML = `<pre style="color:#e5604f;padding:20px">加载失败: ${String(e)}</pre>`;
});
