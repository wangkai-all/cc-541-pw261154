const $ = (sel) => document.querySelector(sel);

const state = {
  latest: null,
  lastOperation: null,
  lastCompare: null,
};

const ACTION_LABEL = {
  capture: '采集两套分页',
  'confirm-mapping': '确认页对应关系',
  'publish-index': '换版检索索引',
  'insert-errata': '插入勘误页',
  'compare-index': '对照页码索引',
  'create-citation': '建立引用',
  'publish-index-blocked-until-mapping-confirmed': '换版被闸门拦下',
  demo: '一次运行全流程',
  reset: '重置',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function chip(label, kind) {
  return el('span', { class: `chip ${kind || ''}`.trim() }, label);
}

function badge(text, tone) {
  return el('span', { class: `badge ${tone || ''}`.trim() }, text);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({ ok: false, error: { message: '响应不是 JSON' } }));
  return { status: res.status, body };
}

async function runOperation(action, params = {}) {
  const { status, body } = await api('/api/operation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  if (action === 'reset') {
    state.lastOperation = null;
    state.lastCompare = null;
  }
  if (body.state) applyState(body.state);
  if (body.operation) renderOperation(body.operation, status);
  return body;
}

function applyState(snapshot) {
  state.latest = snapshot;
  if (!state.lastCompare && snapshot.lastCompare?.result) {
    state.lastCompare = snapshot.lastCompare.result;
  }
  const active = snapshot.index.activeVersionId || '—';
  $('#digest-badge').textContent = `索引 ${active} · 引用 ${snapshot.citations.length} · 版本 ${snapshot.index.versions.length}`;
  renderFeeds(snapshot);
  renderCompare(snapshot);
  renderCitations(snapshot);
  renderVersions(snapshot);
  renderOps(snapshot);
  renderErrataSelect(snapshot);
}

function renderErrataSelect(snapshot) {
  const select = $('#errata-item');
  const current = select.value;
  select.replaceChildren(
    ...snapshot.items.map((item) => el('option', { value: item.itemId }, `${item.title}`)),
  );
  if (current) select.value = current;
}

function renderFeeds(snapshot) {
  const host = $('#feeds');
  host.replaceChildren();
  for (const item of snapshot.items) {
    const capture = item.activeCapture;
    if (!capture) {
      host.append(el('p', { class: 'empty' }, `${item.title}：尚未采集`));
      continue;
    }
    const scanSeq = capture.feeds.scan.sequence.map((leafId) => {
      const leaf = capture.leaves.find((l) => l.leafId === leafId);
      return leaf;
    });
    const printSeq = capture.feeds.print.sequence.map((leafId) => capture.leaves.find((l) => l.leafId === leafId));

    const scanChips = scanSeq.map((leaf) =>
      chip(
        leaf.label,
        [leaf.kind === 'errata' ? 'errata' : '', leaf.duplicate ? 'dup' : ''].join(' ').trim(),
      ),
    );
    // Highlight leaves whose position changed between the two feeds.
    const scanPos = new Map(scanSeq.map((leaf, i) => [leaf.pageId, i]));
    const printPos = new Map(printSeq.map((leaf, i) => [leaf.pageId, i]));
    for (const [pageId, i] of scanPos) {
      if (printPos.get(pageId) !== i) scanChips[i]?.classList.add('shift');
    }

    host.append(
      el(
        'div',
        { class: 'compare-row' },
        el('div', { class: 'compare-title' }, el('strong', {}, item.title), el('span', { class: 'mini' }, item.edition || '')),
        el('div', { class: 'mini' }, '归档服务 A · 扫描页序'),
        el('div', { class: 'seq' }, ...scanChips),
        el('div', { class: 'mini' }, '归档服务 B · 印刷页码'),
        el(
          'div',
          { class: 'seq' },
          ...printSeq.map((leaf) => chip(leaf.label, leaf.kind === 'errata' ? 'errata' : '')),
        ),
      ),
    );
  }
}

function renderCompare(snapshot) {
  const host = $('#compare');
  host.replaceChildren();
  const compare = state.lastCompare;

  if (!compare) {
    host.append(el('p', { class: 'empty' }, '运行“对照页码索引”后，这里列出两套序的位次差异与索引覆盖。'));
    return;
  }
  for (const item of compare.items) {
    if (item.status !== 'captured') continue;
    const mismatchRows = compare.orderMismatches.filter((m) => m.itemId === item.itemId);
    host.append(
      el(
        'div',
        { class: 'compare-row' },
        el('div', { class: 'compare-title' }, el('strong', {}, item.title || item.itemId)),
        el(
          'div',
          { class: 'mini' },
          `对应关系：${item.mapping.status} · 复用 ${item.mapping.counts.reused} / 新页 ${item.mapping.counts.fresh} · 索引文档 ${item.index.docCount}`,
        ),
        mismatchRows.length
          ? el(
              'table',
              {},
              el('thead', {}, el('tr', {}, el('th', {}, '页'), el('th', {}, '扫描位'), el('th', {}, '印刷位'), el('th', {}, '位移'))),
              el(
                'tbody',
                {},
                ...mismatchRows.map((row) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, `${row.section ? row.section + ' ' : ''}${row.label}`),
                    el('td', { class: 'mono' }, row.scanPosition),
                    el('td', { class: 'mono' }, row.printPosition),
                    el('td', { class: 'mono' }, row.delta > 0 ? `+${row.delta}` : row.delta),
                  ),
                ),
              ),
            )
          : el('div', { class: 'mini' }, '两套序在这件馆藏上完全一致。'),
      ),
    );
  }

  if (compare.errata.length) {
    host.append(
      el(
        'div',
        { class: 'compare-row' },
        el('div', { class: 'compare-title' }, el('strong', {}, '勘误页定位')),
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, '页'), el('th', {}, '锚点'), el('th', {}, '扫描位'), el('th', {}, '印刷位'), el('th', {}, '在索引'))),
          el(
            'tbody',
            {},
            ...compare.errata.map((row) =>
              el(
                'tr',
                {},
                el('td', {}, row.label),
                el('td', { class: 'mono' }, row.anchor ? `${row.anchor.section || '—'} 第 ${row.anchor.pageLabel} 页后` : '—'),
                el('td', { class: 'mono' }, row.scanPosition ?? '—'),
                el('td', { class: 'mono' }, row.printPosition ?? '—'),
                el('td', {}, row.inIndex ? '是' : '否'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

function renderCitations(snapshot) {
  const host = $('#citations');
  host.replaceChildren();
  const resolved = state.lastCompare?.citationCheck || null;

  const list = resolved?.citations || null;
  if (!list || list.length === 0) {
    if (snapshot.citations.length === 0) {
      host.append(el('p', { class: 'empty' }, '还没有引用。运行演示会在勘误插入前建立两条旧引用。'));
      return;
    }
    host.append(el('p', { class: 'empty' }, '运行“对照页码索引”以核对旧引用是否仍可解析。'));
    return;
  }

  const wrap = el('div', { class: 'citations' });
  for (const c of list) {
    wrap.append(
      el(
        'div',
        { class: 'citation' },
        el('div', { class: 'who' }, `${c.citationId} · ${c.itemId} · pageId ${c.pageId}`),
        el(
          'div',
          {},
          `印刷页 ${c.section ? c.section + ' ' : ''}${c.label} · `,
          badge(c.preserved ? '可解析' : '丢失', c.preserved ? 'ok' : 'bad'),
          c.docIdStable ? badge('docId 未变', 'ok') : badge('docId 已换', 'warn'),
        ),
        el('div', { class: 'explain' }, c.explanation),
      ),
    );
  }
  host.append(wrap);
}

function renderVersions(snapshot) {
  const host = $('#versions');
  host.replaceChildren();
  if (snapshot.index.versions.length === 0) {
    host.append(el('p', { class: 'empty' }, '尚未发布索引版本。'));
    return;
  }
  host.append(
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, '版本'), el('th', {}, '模式'), el('th', {}, '文档'), el('th', {}, '构成'))),
      el(
        'tbody',
        {},
        ...snapshot.index.versions.map((v) =>
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, `${v.versionId}${v.versionId === snapshot.index.activeVersionId ? ' ●' : ''}`),
            el('td', {}, v.mode === 'rebuild' ? '整件重建' : '逐页复用'),
            el('td', { class: 'mono' }, v.docCount),
            el(
              'td',
              { class: 'mini' },
              v.items.map((i) => `${i.itemId}: 复用 ${i.reused} / 新建 ${i.built}`).join('；'),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderOps(snapshot) {
  const host = $('#ops');
  host.replaceChildren();
  if (!snapshot.ops.length) {
    host.append(el('p', { class: 'empty' }, '还没有操作记录。'));
    return;
  }
  host.append(
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, '操作'), el('th', {}, '动作'), el('th', {}, '结果'), el('th', {}, 'before → after'))),
      el(
        'tbody',
        {},
        ...[...snapshot.ops].reverse().map((op) =>
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, op.operationId),
            el('td', {}, ACTION_LABEL[op.action] || op.action),
            el('td', {}, op.ok ? '通过' : `拒绝 (${op.error?.code || op.status})`),
            el('td', { class: 'mono' }, `${op.beforeDigest} → ${op.afterDigest}`),
          ),
        ),
      ),
    ),
  );
}

function renderOperation(operation, httpStatus) {
  state.lastOperation = operation;
  const demoCompare =
    operation.action === 'demo' && operation.result?.steps
      ? operation.result.steps.find((s) => s.step === 'compare-index')?.result || null
      : null;
  const directCompare = operation.action === 'compare-index' && operation.ok ? operation.result : null;
  if (demoCompare || directCompare) state.lastCompare = demoCompare || directCompare;
  const host = $('#result-body');
  host.replaceChildren();

  const opBadge = $('#op-badge');
  opBadge.textContent = `${operation.operationId} · ${ACTION_LABEL[operation.action] || operation.action}`;
  opBadge.className = `badge ${operation.ok ? 'ok' : 'bad'}`;

  host.append(
    el(
      'div',
      { class: 'step-head' },
      badge(operation.ok ? `HTTP ${httpStatus} 通过` : `HTTP ${httpStatus} 拒绝`, operation.ok ? 'ok' : 'bad'),
      el('span', { class: 'mini' }, `before ${operation.before.stateDigest} → after ${operation.after.stateDigest}`),
    ),
  );

  if (!operation.ok) {
    host.append(
      el(
        'div',
        { class: 'step bad' },
        el('div', { class: 'step-head' }, el('span', { class: 'step-name' }, '被拒绝'), el('span', { class: 'mono' }, operation.error?.code)),
        el('div', { class: 'step-note' }, operation.error?.message),
        ...(operation.error?.details?.blockers || []).map((b) => el('div', { class: 'mini' }, `阻塞 ${b.itemId}：${b.message}`)),
      ),
    );
  }

  const steps =
    operation.action === 'demo' && operation.result?.steps
      ? operation.result.steps
      : [{ step: operation.action, result: operation.result }];

  for (const s of steps) {
    const r = s.result || {};
    const rejected = r.rejected === true;
    const skipped = r.skipped === true;
    const tone = rejected ? 'bad' : skipped ? 'skip' : 'ok';
    const node = el('div', { class: `step ${tone}` });
    node.append(
      el(
        'div',
        { class: 'step-head' },
        el('span', { class: 'step-name' }, ACTION_LABEL[s.step] || s.step),
        rejected
          ? badge('被闸门拦下', 'bad')
          : skipped
            ? badge('跳过', 'warn')
            : r.noop
              ? badge('无变化', 'warn')
              : badge('完成', 'ok'),
      ),
    );
    if (r.note) node.append(el('div', { class: 'step-note' }, r.note));
    if (rejected && r.message) node.append(el('div', { class: 'mini' }, r.message));
    if (r.blockers) {
      for (const b of r.blockers) node.append(el('div', { class: 'mini' }, `阻塞 ${b.itemId}：${b.message}`));
    }
    if (s.step === 'capture' && r.captures) {
      node.append(renderCaptureTables(r.captures));
    }
    if (s.step === 'insert-errata' && !skipped) {
      node.append(
        el('div', { class: 'mini' },
          `勘误 ${r.signature} 锚定在「${r.anchor.section || '—'} 第 ${r.anchor.pageLabel} 页」之后；`,
          `原件版本 ${r.previousCaptureVersionId} → ${r.captureVersionId}；pageId ${r.errataPageId}`,
        ),
        el('div', { class: 'mini' }, `印刷序：${r.printSequence?.join(' · ') || '—'}`),
      );
    }
    if (s.step === 'confirm-mapping' && !skipped) {
      node.append(
        el('div', { class: 'mini' },
          `${r.mappingId}：matched ${r.counts?.matched} / reused ${r.counts?.reused} / fresh ${r.counts?.fresh} / conflicts ${r.counts?.conflicts}`,
        ),
      );
    }
    if (s.step === 'publish-index' && !skipped) {
      node.append(
        el('div', { class: 'mini' },
          r.noop
            ? `未产生新版本，仍为 ${r.indexVersionId}`
            : `${r.previousVersionId || '(初版)'} → ${r.indexVersionId}；复用 ${r.reusedDocs} 篇、新建 ${r.rebuiltDocs} 篇、digest ${r.digest}`,
        ),
      );
    }
    if (s.step === 'create-citation' && !skipped) {
      node.append(el('div', { class: 'mini' }, `${r.citationId} · pageId ${r.pageId} · 原索引文档 ${r.originallyIndexedAs || '—'}`));
    }
    if (s.step === 'compare-index' && r.checks) {
      node.append(
        el('ul', { class: 'checks' }, ...r.checks.map((c) => el('li', {}, el('span', { class: `mark ${c.status}` }, c.status), el('span', {}, `${c.id}：${c.detail}`)))),
        el('div', { class: 'mini' }, `counts ${JSON.stringify(r.summary)} · digest ${r.digest}`),
      );
    }
    host.append(node);
  }

  host.append(el('div', { class: 'mini' }, `操作前摘要：${operation.before.items.length} 件馆藏，索引 ${operation.before.activeIndexVersionId || '(无)'}，引用 ${operation.before.citationCount}；操作后：索引 ${operation.after.activeIndexVersionId || '(无)'}，引用 ${operation.after.citationCount}，检索文档 ${operation.after.activeIndexDocCount}。`));

  for (const note of operation.notes || []) {
    host.append(el('div', { class: 'mini' }, `· ${note}`));
  }

  renderCompare(state.latest);
  renderCitations(state.latest);
}

function renderCaptureTables(captures) {
  return el(
    'div',
    {},
    ...captures.map((c) =>
      el(
        'div',
        { class: 'compare-row' },
        el('div', { class: 'compare-title' }, el('strong', {}, c.itemId), el('span', { class: 'mini' }, c.captureVersionId)),
        el('div', { class: 'mini' }, `扫描页序：${c.scanSequence.join(' · ')}`),
        el('div', { class: 'mini' }, `印刷页码：${c.printSequence.join(' · ')}`),
        c.duplicateFrames?.length
          ? el('div', { class: 'mini' }, `重复底片折叠：${c.duplicateFrames.map((d) => `${d.label} ×${d.copies}`).join('；')}`)
          : null,
        c.conflicts?.length
          ? el('div', { class: 'mini' }, `同页号冲突：${c.conflicts.map((x) => x.pageKey).join('；')}`)
          : null,
      ),
    ),
  );
}

async function refresh() {
  const { body } = await api('/api/state');
  if (body.ok) applyState(body);
}

async function doSearch(event) {
  event.preventDefault();
  const q = $('#search-q').value.trim();
  const { status, body } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const host = $('#result-body');
  host.prepend(
    el(
      'div',
      { class: `step ${body.ok ? 'ok' : 'bad'} flash` },
      el(
        'div',
        { class: 'step-head' },
        el('span', { class: 'step-name' }, `检索「${q || '空'}」`),
        badge(`HTTP ${status}`, body.ok ? 'ok' : 'bad'),
        el('span', { class: 'mini' }, `索引 ${body.indexVersionId || '—'}`),
      ),
      body.ok
        ? el(
            'div',
            {},
            el('div', { class: 'mini' }, `命中 ${body.total} 条`),
            ...body.results.slice(0, 6).map((r) =>
              el(
                'div',
                { class: 'citation' },
                el('div', { class: 'who' }, `${r.itemTitle} · ${r.section || '—'} ${r.label} · pageId ${r.pageId}`),
                el('div', {}, r.snippet || r.text),
                el('div', { class: 'mini' }, r.reused ? '复用文档' : '新文档', r.current ? ' · 当前原件版本一致' : ' · 与当前原件不一致'),
              ),
            ),
          )
        : el('div', { class: 'step-note' }, body.error?.message || '检索失败'),
    ),
  );
}

$('#run-demo').addEventListener('click', async () => {
  const mode = $('#mode').value;
  const button = $('#run-demo');
  button.disabled = true;
  try {
    await runOperation('demo', { mode });
  } finally {
    button.disabled = false;
  }
});

$('#reset').addEventListener('click', async () => {
  await runOperation('reset', {});
});

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    const mode = $('#mode').value;
    const itemId = $('#errata-item').value;
    button.disabled = true;
    try {
      if (action === 'capture') await runOperation('capture', { mode });
      if (action === 'confirm') await runOperation('confirm-mapping', { itemId, mode });
      if (action === 'publish') await runOperation('publish-index', { mode });
      if (action === 'errata')
        await runOperation('insert-errata', {
          itemId,
          afterSection: '',
          afterPageLabel: $('#errata-page').value,
          text: $('#errata-text').value,
          mode,
        });
      if (action === 'compare') await runOperation('compare-index', {});
    } finally {
      button.disabled = false;
    }
  });
}

$('#search-form').addEventListener('submit', doSearch);

refresh();
