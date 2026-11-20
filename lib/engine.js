'use strict';

const {
  citationSortOrder,
  normalizeText,
  nowIso,
  safeInt,
  sha256,
  shortHash,
  stableStringify,
  truncate,
} = require('./util');

const FEED_SCAN = 'scan';
const FEED_PRINT = 'print';
const MAX_OPS = 80;

function pad(n, width = 3) {
  return String(n).padStart(width, '0');
}

function pageKeyOf(raw) {
  if (raw.kind === 'errata') {
    return `errata|${raw.signature || sha256(normalizeText(raw.text))}`;
  }
  return `page|${raw.section || ''}|${raw.pageLabel}`;
}

function pageIdOf(itemId, pageKey, checksum) {
  return `PG-${shortHash(`${itemId}|${pageKey}|${checksum}`, 16)}`;
}

function numericLabel(label) {
  const match = String(label ?? '').trim().match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

function buildSections(rawLeaves) {
  const rank = new Map();
  for (const leaf of rawLeaves) {
    const section = leaf.section || '';
    if (!rank.has(section)) rank.set(section, rank.size);
  }
  return rank;
}

/**
 * Printed-page order: section order of first appearance, then numeric page
 * label, then label text. Errata leaves carry an anchor and are inserted after
 * the anchored page (or at the end when no anchor survives).
 */
function computePrintSequence(pages, sectionRank) {
  const printable = pages.filter((page) => page.kind === 'page');
  printable.sort((a, b) => {
    const rankA = sectionRank.get(a.section || '') ?? Number.MAX_SAFE_INTEGER;
    const rankB = sectionRank.get(b.section || '') ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    const numA = numericLabel(a.label);
    const numB = numericLabel(b.label);
    if (numA !== numB) return numA - numB;
    return String(a.label).localeCompare(String(b.label));
  });

  const sequence = printable.map((page) => page.primaryLeafId);
  const errata = pages.filter((page) => page.kind === 'errata');
  errata.sort((a, b) => a.scanOrdinal - b.scanOrdinal);

  const insertedAfter = new Map();
  for (const leaf of errata) {
    const anchorKey = leaf.anchorPageKey || null;
    let insertAt = sequence.length;
    if (anchorKey) {
      const anchorLeafId = pages.find((p) => p.pageKey === anchorKey && p.kind === 'page')?.primaryLeafId;
      if (anchorLeafId) {
        const base = sequence.indexOf(anchorLeafId);
        if (base >= 0) {
          const already = insertedAfter.get(anchorLeafId) || 0;
          insertAt = base + 1 + already;
          insertedAfter.set(anchorLeafId, already + 1);
        }
      }
    }
    sequence.splice(insertAt, 0, leaf.primaryLeafId);
  }
  return sequence;
}

function summarizeState(state) {
  const activeIndex = state.index.versions.find((v) => v.versionId === state.index.activeVersionId) || null;
  const items = state.items.map((item) => {
    const capture = item.captures[item.captures.length - 1] || null;
    const mapping = item.mappings.find((m) => m.mappingId === item.activeMappingId) || null;
    const mappingCurrent = Boolean(mapping && capture && mapping.captureVersionId === capture.captureVersionId);
    const activeDocs = activeIndex ? activeIndex.docs.filter((d) => d.itemId === item.itemId) : [];
    const orphanDocs = activeDocs.filter((doc) => {
      const page = capture?.pages.find((p) => p.pageId === doc.pageId);
      return !page || page.checksum !== doc.checksum;
    });
    return {
      itemId: item.itemId,
      title: item.title,
      captureVersionId: capture?.captureVersionId || null,
      captureVersionCount: item.captures.length,
      scanFeed: capture
        ? {
            feedId: capture.feeds.scan.feedId,
            leafCount: capture.feeds.scan.sequence.length,
            pageCount: capture.pages.filter((p) => capture.feeds.scan.sequence.includes(p.primaryLeafId)).length,
            labels: capture.feeds.scan.sequence.map(
              (leafId) => capture.leaves.find((l) => l.leafId === leafId)?.label ?? leafId,
            ),
          }
        : null,
      printFeed: capture
        ? {
            feedId: capture.feeds.print.feedId,
            leafCount: capture.feeds.print.sequence.length,
            pageCount: capture.pages.filter((p) => capture.feeds.print.sequence.includes(p.primaryLeafId)).length,
            labels: capture.feeds.print.sequence.map(
              (leafId) => capture.leaves.find((l) => l.leafId === leafId)?.label ?? leafId,
            ),
          }
        : null,
      mapping: mapping
        ? {
            mappingId: mapping.mappingId,
            captureVersionId: mapping.captureVersionId,
            status: mappingCurrent ? 'confirmed' : 'stale',
            matched: mapping.counts.matched,
            reused: mapping.counts.reused,
            confirmedAt: mapping.confirmedAt,
          }
        : null,
      conflictCount: capture ? capture.conflicts.length : 0,
      duplicateCount: capture ? capture.pages.filter((p) => p.leafIds.length > 1).length : 0,
      errataLabels: capture ? capture.pages.filter((p) => p.kind === 'errata').map((p) => p.label) : [],
      activeIndexDocs: activeDocs.length,
      staleIndexDocs: orphanDocs.length,
    };
  });

  const digestSource = {
    items: state.items.map((item) => ({
      itemId: item.itemId,
      captures: item.captures.map((c) => ({
        captureVersionId: c.captureVersionId,
        mode: c.mode,
        leaves: c.leaves.map((l) => [l.leafId, l.pageId, l.checksum]),
        scan: c.feeds.scan.sequence,
        print: c.feeds.print.sequence,
      })),
      activeMappingId: item.activeMappingId,
    })),
    index: {
      activeVersionId: state.index.activeVersionId,
      versions: state.index.versions.map((v) => [v.versionId, v.docs.map((d) => [d.docId, d.checksum])]),
    },
    citations: state.citations.map((c) => [c.citationId, c.pageId]),
  };

  return {
    stateDigest: shortHash(stableStringify(digestSource), 20),
    activeIndexVersionId: state.index.activeVersionId,
    indexVersionCount: state.index.versions.length,
    activeIndexDocCount: activeIndex ? activeIndex.docs.length : 0,
    citationCount: state.citations.length,
    operationCount: state.ops.length,
    items,
    metrics: { ...state.metrics },
  };
}

class ArchiveEngine {
  constructor(store, fixtures) {
    this.store = store;
    this.fixtures = fixtures;
  }

  get state() {
    return this.store.state;
  }

  fixtureItems(name = 'sample') {
    if (name === 'test') return this.fixtures.SAMPLE_TEST_ARCHIVE.items;
    if (name === 'sample') return this.fixtures.SAMPLE_ARCHIVE.items;
    return null;
  }

  // ---------------------------------------------------------------- public API

  execute(action, params = {}) {
    const before = summarizeState(this.store.state);
    const opId = `OP-${pad(++this.store.state.seq.operation, 5)}`;
    let result;
    let status = 200;
    let ok = true;
    let error = null;

    const finish = () => {
      // Re-read: reset actions replace the whole state object.
      const state = this.store.state;
      const after = summarizeState(state);
      const operation = {
        operationId: opId,
        action,
        at: nowIso(),
        ok,
        status,
        before,
        after,
        result: result ?? null,
        error,
        notes: this._notesFor(action, result, error),
      };
      state.ops.push(operation);
      if (state.ops.length > MAX_OPS) state.ops.splice(0, state.ops.length - MAX_OPS);
      state.lastOperationId = opId;
      state.lastOperationSummary = after;
      state.updatedAt = nowIso();
      this.store.save();
      return operation;
    };

    try {
      switch (action) {
        case 'capture':
          result = this._capture(params, opId);
          break;
        case 'insert-errata':
          result = this._insertErrata(params, opId);
          break;
        case 'confirm-mapping':
          result = this._confirmMapping(params, opId);
          break;
        case 'publish-index':
          result = this._publishIndex(params, opId);
          break;
        case 'compare-index':
          result = this._compareIndex(params);
          break;
        case 'create-citation':
          result = this._createCitation(params);
          break;
        case 'demo':
          result = this._demo(params, opId);
          break;
        case 'reset':
          result = this._reset(params);
          break;
        default:
          status = 400;
          ok = false;
          error = { code: 'unknown_action', message: `未知操作 ${action}` };
      }
    } catch (err) {
      ok = false;
      status = err.status || 500;
      error = {
        code: err.code || 'internal_error',
        message: err.message || '内部错误',
        details: err.details || null,
      };
      result = err.details?.partial || null;
    }

    if (action === 'compare-index' && ok && result) {
      this.store.state.lastCompare = { at: result.at, digest: result.digest, summary: result.summary, result };
    }

    return finish();
  }

  publicState() {
    const state = this.state;
    const activeIndex = state.index.versions.find((v) => v.versionId === state.index.activeVersionId) || null;
    return {
      updatedAt: state.updatedAt,
      seq: { ...state.seq },
      metrics: { ...state.metrics },
      lastOperationId: state.lastOperationId,
      lastOperationSummary: state.lastOperationSummary,
      lastCompare: state.lastCompare || null,
      items: state.items.map((item) => {
        const capture = item.captures[item.captures.length - 1] || null;
        const preview = capture ? this._buildMapping(item, capture) : null;
        const mapping = item.mappings.find((m) => m.mappingId === item.activeMappingId) || null;
        return {
          itemId: item.itemId,
          title: item.title,
          edition: item.edition,
          note: item.note,
          captureVersions: item.captures.map((c) => ({
            captureVersionId: c.captureVersionId,
            n: c.n,
            createdAt: c.createdAt,
            reason: c.reason,
            mode: c.mode,
            leafCount: c.leaves.length,
            pageCount: c.pages.length,
            scanSequence: c.feeds.scan.sequence.map((id) => c.leaves.find((l) => l.leafId === id)?.label ?? id),
            printSequence: c.feeds.print.sequence.map((id) => c.leaves.find((l) => l.leafId === id)?.label ?? id),
          })),
          activeCapture: capture,
          mappingPreview: preview,
          activeMapping: mapping,
          activeIndexDocs: activeIndex ? activeIndex.docs.filter((d) => d.itemId === item.itemId) : [],
        };
      }),
      index: {
        activeVersionId: state.index.activeVersionId,
        versions: state.index.versions.map((v) => ({
          versionId: v.versionId,
          n: v.n,
          createdAt: v.createdAt,
          mode: v.mode,
          parentVersionId: v.parentVersionId,
          docCount: v.docs.length,
          items: v.items,
          digest: shortHash(stableStringify(v.docs.map((d) => [d.docId, d.checksum])), 16),
        })),
      },
      citations: state.citations.map((c) => ({ ...c })),
      ops: state.ops.slice(-15).map((op) => ({
        operationId: op.operationId,
        action: op.action,
        at: op.at,
        ok: op.ok,
        status: op.status,
        error: op.error,
        beforeDigest: op.before.stateDigest,
        afterDigest: op.after.stateDigest,
      })),
    };
  }

  search(params = {}) {
    const q = normalizeText(params.q);
    const state = this.state;
    const versionId = params.indexVersionId || state.index.activeVersionId;
    const version = state.index.versions.find((v) => v.versionId === versionId);
    state.metrics.searches += 1;
    if (!q) {
      this.store.save();
      return {
        ok: false,
        status: 400,
        error: { code: 'empty_query', message: '检索词不能为空' },
        indexVersionId: versionId || null,
        activeVersionId: state.index.activeVersionId,
        results: [],
      };
    }
    if (!version) {
      this.store.save();
      return {
        ok: false,
        status: 409,
        error: {
          code: 'index_not_published',
          message: '检索索引尚未换版；请先确认页对应关系并发布索引',
        },
        indexVersionId: versionId || null,
        activeVersionId: state.index.activeVersionId,
        results: [],
      };
    }
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const doc of version.docs) {
      const haystack = normalizeText(
        `${doc.itemId} ${doc.label} ${doc.section || ''} ${doc.pageKey} ${doc.text}`,
      ).toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
      let score = 0;
      for (const token of tokens) {
        const occurrences = haystack.split(token).length - 1;
        score += occurrences;
        if (normalizeText(doc.label).toLowerCase() === token) score += 10;
      }
      const item = state.items.find((i) => i.itemId === doc.itemId);
      const current = item?.captures[item.captures.length - 1];
      const currentPage = current?.pages.find((p) => p.pageId === doc.pageId);
      results.push({
        docId: doc.docId,
        pageId: doc.pageId,
        itemId: doc.itemId,
        itemTitle: item?.title || doc.itemId,
        pageKey: doc.pageKey,
        section: doc.section || '',
        label: doc.label,
        kind: doc.kind,
        text: doc.text,
        snippet: this._snippet(doc.text, tokens),
        indexVersionId: version.versionId,
        captureVersionId: doc.captureVersionId,
        checksum: doc.checksum,
        reused: Boolean(doc.reused),
        current: Boolean(currentPage && currentPage.checksum === doc.checksum),
        score,
      });
    }
    results.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId) || a.label.localeCompare(b.label));
    state.metrics.searchHits += results.length > 0 ? 1 : 0;
    this.store.save();
    return {
      ok: true,
      status: 200,
      query: q,
      indexVersionId: version.versionId,
      activeVersionId: state.index.activeVersionId,
      total: results.length,
      results: results.slice(0, 20),
    };
  }

  resolveCitations() {
    const state = this.state;
    const active = state.index.versions.find((v) => v.versionId === state.index.activeVersionId) || null;
    const citations = [...state.citations].sort(citationSortOrder).map((citation) => {
      const activeDoc = active?.docs.find((d) => d.pageId === citation.pageId && d.itemId === citation.itemId) || null;
      const history = [];
      for (const version of state.index.versions) {
        if (version.versionId === active?.versionId) continue;
        const doc = version.docs.find((d) => d.pageId === citation.pageId && d.itemId === citation.itemId);
        if (doc) {
          history.push({
            indexVersionId: version.versionId,
            docId: doc.docId,
            label: doc.label,
            section: doc.section || '',
            captureVersionId: doc.captureVersionId,
            checksum: doc.checksum,
          });
        }
      }
      const item = state.items.find((i) => i.itemId === citation.itemId);
      const capture = item?.captures[item.captures.length - 1] || null;
      const currentPage = capture?.pages.find((p) => p.pageId === citation.pageId) || null;
      const currentByKey = capture?.pages.find((p) => p.pageKey === citation.pageKey) || null;
      const anyDoc = activeDoc || history[history.length - 1] || null;
      const contentChanged = Boolean(
        citation.checksum &&
          (currentByKey && currentByKey.checksum !== citation.checksum ||
            (!currentByKey && anyDoc && anyDoc.checksum !== citation.checksum)),
      );
      return {
        citationId: citation.citationId,
        itemId: citation.itemId,
        itemTitle: item?.title || citation.itemId,
        pageId: citation.pageId,
        pageKey: citation.pageKey,
        section: citation.section || '',
        label: citation.label,
        originallyIndexedAs: citation.originallyIndexedAs || null,
        createdAt: citation.createdAt,
        active: activeDoc
          ? {
              indexVersionId: active.versionId,
              docId: activeDoc.docId,
              label: activeDoc.label,
              captureVersionId: activeDoc.captureVersionId,
              checksum: activeDoc.checksum,
            }
          : null,
        history,
        preserved: Boolean(activeDoc) || history.length > 0,
        stillInCurrentCapture: Boolean(currentPage),
        currentChecksum: currentPage?.checksum || null,
        contentChanged,
        docIdStable:
          Boolean(activeDoc) &&
          (!citation.originallyIndexedAs || citation.originallyIndexedAs === activeDoc.docId),
        explanation: activeDoc
          ? citation.originallyIndexedAs && citation.originallyIndexedAs !== activeDoc.docId
            ? `引用建立时的索引文档 ${citation.originallyIndexedAs} 已随整件重建更换为 ${activeDoc.docId}；引用绑定 pageId，因此仍然命中。`
            : '当前生效索引仍包含该页，引用按稳定 pageId 命中，文档标识未变。'
          : history.length > 0
            ? contentChanged
              ? `该页内容已改版（校验和变化），新索引为其分配了新的 pageId；引用仍指向原 pageId，旧索引版本 ${history.map((h) => h.indexVersionId).join('、')} 保留原件文档，因此旧引用照常解析，不会被静默改写为新版正文。`
              : `当前索引不再收录该页，但旧索引版本 ${history.map((h) => h.indexVersionId).join('、')} 保留原文档，旧引用仍可解析。`
            : '该引用在保留的索引版本中也找不到；请检查是否绕过采集器写入了引用。',
      };
    });
    return {
      ok: true,
      activeVersionId: active?.versionId || null,
      indexVersionCount: state.index.versions.length,
      total: citations.length,
      resolvedInActive: citations.filter((c) => c.active).length,
      preservedInHistoryOnly: citations.filter((c) => !c.active && c.history.length > 0).length,
      missing: citations.filter((c) => !c.preserved).length,
      citations,
    };
  }

  // ------------------------------------------------------------- operations

  _reset(params) {
    const fixtureName = params.fixture || 'sample';
    if (!this.fixtureItems(fixtureName)) {
      throw httpError(400, 'unknown_fixture', `未知本地样例 ${fixtureName}`);
    }
    this.store.reset();
    this.state.fixture = fixtureName;
    return { reset: true, fixture: fixtureName, note: '本地状态已清空；原件、映射、索引版本与引用均已删除。' };
  }

  /**
   * The one-click story: capture both feeds, confirm the mapping, publish v1,
   * anchor two citations, insert an errata leaf, show the gate refusing v2
   * until the mapping is re-confirmed, then publish v2 and compare.
   */
  _demo(params, opId) {
    const fixtureName = params.fixture || 'sample';
    const mode = params.mode === 'rebuild' ? 'rebuild' : 'reuse';
    const steps = [];
    const wasEmpty = this.state.items.length === 0;
    const add = (step, result) => {
      steps.push({ step, result });
      return result;
    };

    if (wasEmpty) {
      add('capture', this._capture({ fixture: fixtureName }, opId));
    } else {
      add('capture', {
        skipped: true,
        note: '本地已有采集版本；演示从现有原件版本继续。点“重置本地样例”可从头开始。',
      });
    }

    const atlas = this.state.items.find((i) => i.itemId === 'ITEM-ATLAS') || this.state.items[0];
    const journal = this.state.items.find((i) => i.itemId === 'ITEM-JOURNAL');
    if (!atlas) throw httpError(409, 'no_items', '没有可操作的馆藏');

    add('confirm-mapping', this._confirmMapping({ itemId: atlas.itemId, mode }, opId));
    if (journal && !journal.mappings.length) {
      add('confirm-mapping', this._confirmMapping({ itemId: journal.itemId, mode }, opId));
    }

    add('publish-index', this._safePublish({ mode }));

    if (this.state.citations.length === 0) {
      const atlasCapture = atlas.captures[atlas.captures.length - 1];
      const atlasP2 = atlasCapture.pages.find((p) => p.pageKey === 'page||2');
      if (atlasP2) add('create-citation', this._createCitation({ itemId: atlas.itemId, pageId: atlasP2.pageId }));
      if (journal) {
        const journalCapture = journal.captures[journal.captures.length - 1];
        const c2p1 = journalCapture.pages.find((p) => p.pageKey === 'page|第二章|1');
        if (c2p1) add('create-citation', this._createCitation({ itemId: journal.itemId, pageId: c2p1.pageId }));
      }
    } else {
      add('create-citation', { skipped: true, note: '已有引用；演示复用旧引用。' });
    }

    const alreadyHasErrata = atlas.originals.some(
      (raw) => raw.kind === 'errata' && raw.signature === 'DEMO-ERRATA-1',
    );
    if (alreadyHasErrata) {
      add('insert-errata', {
        skipped: true,
        note: '演示勘误页已在原件中；重复演示不会重复插入。',
      });
    } else {
      add(
        'insert-errata',
        this._insertErrata(
          {
            itemId: atlas.itemId,
            afterSection: params.afterSection ?? '',
            afterPageLabel: params.afterPageLabel ?? '2',
            text: params.text,
            mode,
            signature: 'DEMO-ERRATA-1',
          },
          opId,
        ),
      );

      add('publish-index-blocked-until-mapping-confirmed', this._safePublish({ mode }));

      add('confirm-mapping', this._confirmMapping({ itemId: atlas.itemId, mode }, opId));
      add('publish-index', this._safePublish({ mode }));
    }

    const comparison = this._compareIndex({});
    this.state.lastCompare = {
      at: comparison.at,
      digest: comparison.digest,
      summary: comparison.summary,
      result: comparison,
    };
    add('compare-index', comparison);

    return {
      fixture: fixtureName,
      mode,
      steps,
      note:
        '全流程完成：采集两套分页 → 确认对应关系 → 首版索引 → 建立旧引用 → 插入勘误 → ' +
        '索引被对应关系闸门拦下 → 重新确认（复用旧页 pageId）→ 换版 → 对照页码索引。' +
        '旧引用在新索引中仍按 pageId 命中；即使整件重建，旧索引版本也保留其文档。',
    };
  }

  _safePublish(params) {
    try {
      return this._publishIndex(params);
    } catch (err) {
      if (err.status !== 409) throw err;
      return {
        rejected: true,
        code: err.code,
        message: err.message,
        blockers: err.details?.blockers || null,
        note: '闸门生效：页对应关系未确认，索引未换版。',
      };
    }
  }

  _capture(params, opId) {
    const fixtureName = params.fixture || this.state.fixture || 'sample';
    const fixtureItems = this.fixtureItems(fixtureName);
    const requestedRaw = params.itemIds ?? params.itemId ?? null;
    const requested = requestedRaw
      ? (Array.isArray(requestedRaw) ? requestedRaw : String(requestedRaw).split(',').map((s) => s.trim())).filter(Boolean)
      : null;
    if (fixtureItems && this.state.items.length === 0) {
      this.state.fixture = fixtureName;
      for (const seed of fixtureItems) {
        this.state.items.push({
          itemId: seed.id,
          title: seed.title,
          edition: seed.edition || '',
          note: seed.note || '',
          originals: this._normalizeOriginals(seed.scan),
          captures: [],
          mappings: [],
          activeMappingId: null,
        });
      }
    }
    let items = this.state.items;
    if (requested) {
      const known = new Set(this.state.items.map((i) => i.itemId));
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw httpError(404, 'item_not_found', `找不到馆藏 ${unknown.join('、')}`);
      }
      items = items.filter((i) => requested.includes(i.itemId));
    }
    if (items.length === 0) throw httpError(409, 'no_items', '没有可采集的馆藏；请使用本地样例或指定 itemId');

    const mode = params.mode === 'rebuild' ? 'rebuild' : 'reuse';
    const captured = [];
    for (const item of items) {
      if (item.originals.length === 0) throw httpError(409, 'empty_item', `${item.itemId} 没有原件`);
      const capture = this._createCapture(item, mode, item.captures.length > 0 ? 'recapture' : 'initial');
      item.captures.push(capture);
      // Keep the previously confirmed mapping in place but stale. The publish
      // gate compares its captureVersionId with the new capture and refuses it;
      // clearing it here would blur "never confirmed" with "out of date".
      this.state.metrics.captureRuns += 1;
      this.state.metrics.captureVersions += 1;
      captured.push({
        itemId: item.itemId,
        captureVersionId: capture.captureVersionId,
        scanFeedId: capture.feeds.scan.feedId,
        printFeedId: capture.feeds.print.feedId,
        scanSequence: capture.feeds.scan.sequence.map((id) => capture.leaves.find((l) => l.leafId === id)?.label),
        printSequence: capture.feeds.print.sequence.map((id) => capture.leaves.find((l) => l.leafId === id)?.label),
        pageIds: capture.pages.map((p) => ({ pageId: p.pageId, pageKey: p.pageKey, label: p.label, section: p.section })),
        duplicateFrames: capture.pages
          .filter((p) => p.leafIds.length > 1)
          .map((p) => ({ pageId: p.pageId, label: p.label, copies: p.leafIds.length, keptLeafId: p.primaryLeafId })),
        conflicts: capture.conflicts,
      });
    }
    return {
      fixture: fixtureName,
      mode,
      captures: captured,
      note:
        '扫描页序与印刷页码分别落成两套 feed；同一 pageId 的重复底片折叠为一个逻辑页并保留主本，' +
        '页码相同但校验和不同的情况记入 conflicts，不会被静默合并。',
    };
  }

  _insertErrata(params, opId) {
    const itemId = params.itemId;
    if (!itemId) throw httpError(400, 'item_required', '插入勘误需要 itemId');
    const item = this.state.items.find((i) => i.itemId === itemId);
    if (!item) throw httpError(404, 'item_not_found', `找不到馆藏 ${itemId}`);
    if (!item.captures.length) throw httpError(409, 'not_captured', `${itemId} 尚未采集，不能插入勘误`);
    const afterSection = params.afterSection ?? '';
    const afterPageLabel = params.afterPageLabel ?? '';
    const anchorKey = `page|${afterSection}|${afterPageLabel}`;
    const anchorIndex = item.originals.findIndex(
      (raw) => raw.kind === 'page' && pageKeyOf(raw) === anchorKey,
    );
    if (anchorIndex < 0) {
      throw httpError(400, 'anchor_not_found', `找不到勘误锚点：${afterSection || '(无章)'} 第 ${afterPageLabel} 页`);
    }
    const signature = String(params.signature || `ERR-${itemId}-${this.state.seq.errata + 1}`);
    if (item.originals.some((raw) => raw.kind === 'errata' && raw.signature === signature)) {
      throw httpError(409, 'errata_exists', `勘误 ${signature} 已存在，未重复插入`);
    }
    this.state.seq.errata += 1;
    const errata = {
      sourceId: `errata-${this.state.seq.errata}`,
      sheet: 0,
      pageLabel: params.pageLabel || `勘误 ${this.state.seq.errata}`,
      kind: 'errata',
      section: afterSection,
      signature,
      text: normalizeText(
        params.text ||
          `勘误：${afterSection || ''}第 ${afterPageLabel} 页之后插入的补页。本页无印刷页码，按锚点定位。`,
      ),
      note: params.note || '由本地校对台插入的勘误页。',
      anchor: { section: afterSection, pageLabel: afterPageLabel },
    };
    item.originals.splice(anchorIndex + 1, 0, errata);
    item.originals.forEach((raw, index) => {
      raw.sheet = index + 1;
    });
    const mode = params.mode === 'rebuild' ? 'rebuild' : 'reuse';
    const previous = item.captures[item.captures.length - 1];
    const capture = this._createCapture(item, mode, 'errata');
    item.captures.push(capture);
    // Same as a recapture: leave the confirmed mapping in place so the gate
    // can report mapping_stale rather than mapping_not_confirmed.
    this.state.metrics.errataInsertions += 1;
    this.state.metrics.captureVersions += 1;
    const errataPage = capture.pages.find((p) => p.pageKey === pageKeyOf(errata));
    return {
      itemId,
      mode,
      signature,
      anchor: { section: afterSection, pageLabel: afterPageLabel },
      previousCaptureVersionId: previous.captureVersionId,
      captureVersionId: capture.captureVersionId,
      errataPageId: errataPage?.pageId || null,
      errataLeafId: errataPage?.primaryLeafId || null,
      scanSequence: capture.feeds.scan.sequence.map((id) => capture.leaves.find((l) => l.leafId === id)?.label),
      printSequence: capture.feeds.print.sequence.map((id) => capture.leaves.find((l) => l.leafId === id)?.label),
      mappingStatus: 'stale',
      note:
        '勘误页与原页共存于新的原件版本；旧 pageId 不变，引用继续命中旧页。' +
        '新增页使对应关系变为待确认，索引在确认前不会换版。',
    };
  }

  _confirmMapping(params, opId) {
    const item = this._requireItem(params.itemId);
    const capture = item.captures[item.captures.length - 1];
    if (!capture) throw httpError(409, 'not_captured', `${item.itemId} 尚未采集`);
    const existing = item.mappings.find(
      (m) =>
        m.mappingId === item.activeMappingId &&
        m.captureVersionId === capture.captureVersionId &&
        m.status === 'confirmed',
    );
    if (existing && !params.force) {
      return {
        itemId: item.itemId,
        mappingId: existing.mappingId,
        captureVersionId: capture.captureVersionId,
        status: 'confirmed',
        noop: true,
        counts: existing.counts,
        note: '当前原件版本已有确认过的对应关系，未重复生成。',
      };
    }
    const preview = this._buildMapping(item, capture);
    if (!preview.confirmable) {
      throw httpError(409, 'mapping_not_confirmable', '页对应关系尚不能确认', {
        itemId: item.itemId,
        issues: preview.issues,
        counts: preview.counts,
      });
    }
    const mappingId = `MAP-${pad(++this.state.seq.mapping, 4)}`;
    const mapping = {
      mappingId,
      itemId: item.itemId,
      captureVersionId: capture.captureVersionId,
      status: 'confirmed',
      confirmedAt: nowIso(),
      entries: preview.entries,
      counts: preview.counts,
      issues: [],
      mode: params.mode === 'rebuild' ? 'rebuild' : 'reuse',
    };
    item.mappings.push(mapping);
    item.activeMappingId = mappingId;
    this.state.metrics.mappingConfirmations += 1;
    this.state.metrics.mappingReusedPages += mapping.counts.reused;
    this.state.metrics.mappingRekeyedPages += mapping.counts.fresh;
    return {
      itemId: item.itemId,
      mappingId,
      captureVersionId: capture.captureVersionId,
      counts: mapping.counts,
      reusedPageIds: mapping.entries.filter((e) => e.reused).map((e) => e.pageId),
      freshPageIds: mapping.entries.filter((e) => !e.reused).map((e) => e.pageId),
      note:
        '对应关系已确认；逐页复用的条目沿用原 pageId，只有新增或校验和变化的页才算新页。' +
        '索引现在可以换版。',
    };
  }

  _publishIndex(params, opId) {
    this.state.metrics.indexPublishAttempts += 1;
    const targetIds = params.itemId
      ? [params.itemId]
      : this.state.items.filter((i) => i.captures.length > 0).map((i) => i.itemId);
    if (targetIds.length === 0) {
      this.state.metrics.indexPublishRejections += 1;
      throw httpError(409, 'no_captures', '没有已采集的馆藏，无法换版索引');
    }
    const blockers = [];
    const targets = [];
    for (const itemId of targetIds) {
      const item = this.state.items.find((i) => i.itemId === itemId);
      if (!item) {
        blockers.push({ itemId, code: 'item_not_found', message: `找不到 ${itemId}` });
        continue;
      }
      const capture = item.captures[item.captures.length - 1];
      if (!capture) {
        blockers.push({ itemId, code: 'not_captured', message: `${itemId} 尚未采集` });
        continue;
      }
      const mapping = item.mappings.find((m) => m.mappingId === item.activeMappingId);
      if (!mapping) {
        blockers.push({
          itemId,
          code: 'mapping_not_confirmed',
          message: `${itemId} 的页对应关系尚未确认，索引拒绝换版`,
        });
        continue;
      }
      if (mapping.captureVersionId !== capture.captureVersionId) {
        blockers.push({
          itemId,
          code: 'mapping_stale',
          message: `${itemId} 的原件版本已更新（${capture.captureVersionId}），确认过的对应关系属于 ${mapping.captureVersionId}`,
        });
        continue;
      }
      targets.push({ item, capture, mapping });
    }
    if (blockers.length > 0) {
      this.state.metrics.indexPublishRejections += 1;
      throw httpError(409, 'mapping_gate', '索引未换版：页对应关系未就绪', { blockers });
    }

    const mode = params.mode === 'rebuild' ? 'rebuild' : 'reuse';
    const parent = this.state.index.versions.find((v) => v.versionId === this.state.index.activeVersionId) || null;
    const nextIndexN = this.state.seq.index + 1;
    const rebuildTag = `r${nextIndexN}`;
    const targetItemIds = new Set(targets.map((t) => t.item.itemId));
    const docs = [];
    const itemSummaries = [];
    let reusedDocCount = 0;
    let builtDocCount = 0;
    if (parent) {
      for (const doc of parent.docs) {
        if (targetItemIds.has(doc.itemId)) continue;
        // Items outside this publish keep their existing documents verbatim.
        docs.push({ ...doc, reused: true, reusedFromVersionId: parent.versionId });
        reusedDocCount += 1;
      }
    }
    for (const { item, capture, mapping } of targets) {
      const pageById = new Map(capture.pages.map((p) => [p.pageId, p]));
      const previousDocs = parent ? parent.docs.filter((d) => d.itemId === item.itemId) : [];
      let itemReused = 0;
      let itemBuilt = 0;
      let itemDropped = 0;
      if (mode === 'reuse') {
        for (const doc of previousDocs) {
          const page = pageById.get(doc.pageId);
          if (page && page.checksum === doc.checksum) {
            docs.push({ ...doc, reused: true, reusedFromVersionId: parent.versionId });
            itemReused += 1;
            pageById.delete(doc.pageId);
          } else {
            itemDropped += 1;
          }
        }
      } else if (parent) {
        itemDropped = previousDocs.filter((d) => !pageById.has(d.pageId) || pageById.get(d.pageId).checksum !== d.checksum).length;
      }
      for (const page of capture.pages) {
        if (!pageById.has(page.pageId)) continue;
        pageById.delete(page.pageId);
        // reuse  : the index document id equals the stable pageId, so an old
        //          docId reference keeps resolving after new pages appear.
        // rebuild: document ids are regenerated with a version tag, so every
        //          document is fresh, yet citations still bind to pageId and
        //          resolve through the retained old index versions.
        const docId = mode === 'rebuild' ? `${page.pageId}~${rebuildTag}` : page.pageId;
        docs.push(this._docFor(capture, page, item, false, docId));
        itemBuilt += 1;
      }
      reusedDocCount += itemReused;
      builtDocCount += itemBuilt;
      itemSummaries.push({
        itemId: item.itemId,
        captureVersionId: capture.captureVersionId,
        mappingId: mapping.mappingId,
        captureMode: capture.mode,
        indexMode: mode,
        reused: itemReused,
        built: itemBuilt,
        dropped: itemDropped,
      });
    }
    if (docs.length === 0) {
      this.state.metrics.indexPublishRejections += 1;
      throw httpError(409, 'empty_index', '索引构建结果为空，拒绝换版');
    }
    const digest = shortHash(
      stableStringify(docs.map((d) => [d.docId, d.checksum]).sort()),
      20,
    );
    const active = parent;
    if (active && active.digest === digest) {
      this.state.metrics.indexNoopPublishes += 1;
      return {
        noop: true,
        mode,
        indexVersionId: active.versionId,
        docCount: active.docs.length,
        digest,
        note: '索引内容与当前生效版本一致，未创建新版本。',
      };
    }
    const versionId = `IDX-${pad(++this.state.seq.index, 4)}`;
    const version = {
      versionId,
      n: this.state.seq.index,
      createdAt: nowIso(),
      mode,
      parentVersionId: parent?.versionId || null,
      digest,
      items: itemSummaries,
      docs,
    };
    this.state.index.versions.push(version);
    this.state.index.activeVersionId = versionId;
    this.state.metrics.indexVersionsPublished += 1;
    return {
      indexVersionId: versionId,
      previousVersionId: parent?.versionId || null,
      mode,
      docCount: docs.length,
      reusedDocs: reusedDocCount,
      rebuiltDocs: builtDocCount,
      digest,
      items: itemSummaries,
      note:
        '页对应关系已确认，索引完成换版；旧版本仍保留在版本表中，' +
        (mode === 'reuse'
          ? '逐页复用让未变化的 pageId/docId 保持稳定，旧引用无需改写。'
          : '整件重建也只更换索引版本，引用按 pageId 在旧版本中仍可解析。'),
    };
  }

  _compareIndex(params) {
    const itemIds = params.itemId ? [params.itemId] : this.state.items.map((i) => i.itemId);
    const active = this.state.index.versions.find((v) => v.versionId === this.state.index.activeVersionId) || null;
    const items = [];
    const conflicts = [];
    const orderMismatches = [];
    const errataRows = [];
    for (const itemId of itemIds) {
      const item = this.state.items.find((i) => i.itemId === itemId);
      if (!item) continue;
      const capture = item.captures[item.captures.length - 1] || null;
      if (!capture) {
        items.push({ itemId, status: 'not_captured', mapping: null, scan: null, print: null });
        continue;
      }
      const preview = this._buildMapping(item, capture);
      const mapping = item.mappings.find((m) => m.mappingId === item.activeMappingId) || null;
      const mappingCurrent = Boolean(mapping && mapping.captureVersionId === capture.captureVersionId);
      const leafById = new Map(capture.leaves.map((l) => [l.leafId, l]));
      const scanSeq = capture.feeds.scan.sequence.map((leafId, index) => {
        const leaf = leafById.get(leafId);
        return {
          position: index + 1,
          leafId,
          pageId: leaf.pageId,
          label: leaf.label,
          section: leaf.section || '',
          kind: leaf.kind,
          duplicate: leaf.duplicate,
          duplicateOf: leaf.duplicateOf,
        };
      });
      const printSeq = capture.feeds.print.sequence.map((leafId, index) => {
        const leaf = leafById.get(leafId);
        return {
          position: index + 1,
          leafId,
          pageId: leaf.pageId,
          label: leaf.label,
          section: leaf.section || '',
          kind: leaf.kind,
        };
      });
      const scanByPage = new Map();
      for (const row of scanSeq) if (!scanByPage.has(row.pageId)) scanByPage.set(row.pageId, row);
      const printByPage = new Map();
      for (const row of printSeq) if (!printByPage.has(row.pageId)) printByPage.set(row.pageId, row);

      for (const page of capture.pages) {
        const scanRow = scanByPage.get(page.pageId);
        const printRow = printByPage.get(page.pageId);
        if (scanRow && printRow && page.kind === 'page' && scanRow.position !== printRow.position) {
          orderMismatches.push({
            itemId,
            pageId: page.pageId,
            label: page.label,
            section: page.section || '',
            scanPosition: scanRow.position,
            printPosition: printRow.position,
            delta: printRow.position - scanRow.position,
          });
        }
        if (page.kind === 'errata') {
          errataRows.push({
            itemId,
            pageId: page.pageId,
            label: page.label,
            section: page.section || '',
            anchor: page.anchor || null,
            scanPosition: scanRow?.position ?? null,
            printPosition: printRow?.position ?? null,
            inIndex: Boolean(active && active.docs.some((d) => d.pageId === page.pageId)),
          });
        }
      }
      for (const conflict of capture.conflicts) {
        conflicts.push({ itemId, ...conflict });
      }
      const activeDocs = active ? active.docs.filter((d) => d.itemId === itemId) : [];
      const currentPageIds = new Set(capture.pages.map((p) => p.pageId));
      const removedDocs = activeDocs.filter((d) => !currentPageIds.has(d.pageId));
      const staleDocs = activeDocs.filter((d) => {
        const page = capture.pages.find((p) => p.pageId === d.pageId);
        return page && page.checksum !== d.checksum;
      });
      items.push({
        itemId,
        title: item.title,
        status: 'captured',
        captureVersionId: capture.captureVersionId,
        captureMode: capture.mode,
        scan: {
          feedId: capture.feeds.scan.feedId,
          order: 'sheet',
          sequence: scanSeq,
          leafCount: scanSeq.length,
          pageCount: scanByPage.size,
        },
        print: {
          feedId: capture.feeds.print.feedId,
          order: 'printed',
          sequence: printSeq,
          leafCount: printSeq.length,
          pageCount: printByPage.size,
        },
        mapping: {
          previewStatus: preview.confirmable ? 'confirmable' : 'blocked',
          confirmedMappingId: mapping?.mappingId || null,
          confirmedCaptureVersionId: mapping?.captureVersionId || null,
          current: mappingCurrent,
          status: mappingCurrent ? 'confirmed' : mapping ? 'stale' : 'draft',
          counts: preview.counts,
          issues: preview.issues,
        },
        duplicates: capture.pages
          .filter((p) => p.leafIds.length > 1)
          .map((p) => ({
            pageId: p.pageId,
            label: p.label,
            section: p.section || '',
            copies: p.leafIds.length,
            keptLeafId: p.primaryLeafId,
            discardedFrames: p.leafIds.filter((id) => id !== p.primaryLeafId),
          })),
        index: {
          activeVersionId: active?.versionId || null,
          docCount: activeDocs.length,
          removedDocs: removedDocs.map((d) => d.docId),
          staleDocs: staleDocs.map((d) => d.docId),
          missingNewPages: [...currentPageIds].filter((id) => !activeDocs.some((d) => d.pageId === id)),
        },
      });
    }

    const citationCheck = this.resolveCitations();
    const checks = [
      {
        id: 'feeds_captured',
        status: items.every((i) => i.status === 'captured') && items.length > 0 ? 'pass' : 'fail',
        detail: '两套 feed 是否都已落库',
      },
      {
        id: 'same_page_number_isolated',
        status: conflicts.length === 0 ? 'pass' : 'fail',
        detail:
          conflicts.length === 0
            ? '相同页码若分属不同章节，按 section + pageLabel 区分，未误并'
            : `${conflicts.length} 处同页号但校验和不同，已列为冲突，无法自动确认`,
      },
      {
        id: 'duplicates_collapsed',
        status: 'pass',
        detail:
          '重复底片以 pageId 折叠，主本保留，副本只记入 leafIds；引用指向 pageId，因此重复扫描不会改写旧引用。',
      },
      {
        id: 'mapping_confirmed_current',
        status:
          items.length > 0 && items.every((i) => i.mapping?.current) ? 'pass' : 'warn',
        detail: '索引换版要求当前原件版本的对应关系已确认',
      },
      {
        id: 'index_active',
        status: active ? 'pass' : 'warn',
        detail: active ? `当前生效索引 ${active.versionId}` : '尚未发布任何索引版本',
      },
      {
        id: 'index_matches_capture',
        status:
          active && items.every((i) => i.index?.missingNewPages.length === 0 && i.index?.staleDocs.length === 0)
            ? 'pass'
            : 'warn',
        detail: '生效索引是否覆盖当前原件版本的全部页',
      },
      {
        id: 'citations_preserved',
        status: citationCheck.missing === 0 ? 'pass' : 'fail',
        detail:
          citationCheck.total === 0
            ? '还没有引用；建立引用后可在此核对旧引用是否仍可解析'
            : `${citationCheck.total} 条引用，${citationCheck.resolvedInActive} 条命中当前索引，${citationCheck.preservedInHistoryOnly} 条仅存于旧版本但仍可解析`,
      },
    ];

    const result = {
      at: nowIso(),
      activeIndexVersionId: active?.versionId || null,
      indexVersionCount: this.state.index.versions.length,
      items,
      conflicts,
      orderMismatches,
      errata: errataRows,
      citationCheck,
      checks,
      summary: {
        itemCount: items.length,
        captures: items.filter((i) => i.captureVersionId).length,
        conflicts: conflicts.length,
        duplicates: items.reduce((sum, i) => sum + (i.duplicates?.length || 0), 0),
        unmapped:
          items.reduce((sum, i) => sum + (i.mapping?.counts?.onlyScan || 0) + (i.mapping?.counts?.onlyPrint || 0), 0),
        orderMismatches: orderMismatches.length,
        errata: errataRows.length,
        indexDocs: active?.docs.length || 0,
        citations: citationCheck.total,
        citationsPreserved: citationCheck.total - citationCheck.missing,
      },
    };
    result.digest = shortHash(stableStringify(result), 20);
    return result;
  }

  _createCitation(params) {
    const item = this._requireItem(params.itemId);
    const capture = item.captures[item.captures.length - 1];
    if (!capture) throw httpError(409, 'not_captured', `${item.itemId} 尚未采集`);
    const page = capture.pages.find(
      (p) => p.pageId === params.pageId || p.pageKey === params.pageKey || p.primaryLeafId === params.docId,
    );
    if (!page) throw httpError(404, 'page_not_found', '找不到要引用的页');
    const existing = this.state.citations.find((c) => c.itemId === item.itemId && c.pageId === page.pageId);
    if (existing) {
      this.state.metrics.citationsReused += 1;
      this.store.save();
      return {
        citationId: existing.citationId,
        pageId: page.pageId,
        itemId: item.itemId,
        noop: true,
        note: '已有同一 pageId 的引用，复用旧引用，不生成新标识。',
      };
    }
    const citation = {
      citationId: `CIT-${pad(++this.state.seq.citation, 5)}`,
      itemId: item.itemId,
      pageId: page.pageId,
      pageKey: page.pageKey,
      section: page.section || '',
      label: page.label,
      checksum: page.checksum,
      // The rota record of how this citation was first projected into an index.
      originallyIndexedAs: this.state.index.versions
        .find((v) => v.versionId === this.state.index.activeVersionId)
        ?.docs.find((d) => d.pageId === page.pageId && d.itemId === item.itemId)?.docId || null,
      createdAt: nowIso(),
    };
    this.state.citations.push(citation);
    this.state.metrics.citationsCreated += 1;
    this.store.save();
    return { ...citation, note: '引用绑定稳定 pageId，而不是扫描序号或索引文档序号。' };
  }

  // ----------------------------------------------------------------- helpers

  _requireItem(itemId) {
    if (!itemId) throw httpError(400, 'item_required', '需要 itemId');
    const item = this.state.items.find((i) => i.itemId === itemId);
    if (!item) throw httpError(404, 'item_not_found', `找不到馆藏 ${itemId}`);
    return item;
  }

  _normalizeOriginals(scan) {
    return scan
      .map((raw, index) => ({ ...raw, orderIndex: index }))
      .sort((a, b) => (a.sheet ?? 0) - (b.sheet ?? 0) || a.orderIndex - b.orderIndex)
      .map((raw, index) => {
        const normalized = {
          sourceId: raw.id,
          sheet: index + 1,
          pageLabel: String(raw.pageLabel),
          kind: raw.kind === 'errata' ? 'errata' : 'page',
          section: raw.section || '',
          signature: raw.signature || sha256(normalizeText(raw.text)),
          text: normalizeText(raw.text),
          note: raw.note || '',
        };
        if (normalized.kind === 'errata' && raw.anchor) normalized.anchor = { ...raw.anchor };
        return normalized;
      });
  }

  _createCapture(item, mode, reason) {
    const n = item.captures.length + 1;
    const captureVersionId = `CAP-${item.itemId}-v${n}`;
    const originals = item.originals;
    const leaves = originals.map((raw, index) => {
      const checksum = raw.signature || sha256(normalizeText(raw.text));
      const pageKey = pageKeyOf(raw);
      return {
        leafId: `LF-${captureVersionId}-${pad(index + 1)}`,
        captureVersionId,
        sheet: index + 1,
        sourceId: raw.sourceId,
        pageId: pageIdOf(item.itemId, pageKey, checksum),
        pageKey,
        section: raw.section || '',
        label: raw.pageLabel,
        kind: raw.kind,
        checksum,
        text: raw.text,
        note: raw.note || '',
        anchor: raw.anchor || null,
        anchorPageKey: raw.anchor ? `page|${raw.anchor.section || ''}|${raw.anchor.pageLabel}` : null,
        duplicate: false,
        duplicateOf: null,
      };
    });

    const byPageId = new Map();
    const byPageKey = new Map();
    for (const leaf of leaves) {
      if (!byPageId.has(leaf.pageId)) byPageId.set(leaf.pageId, []);
      byPageId.get(leaf.pageId).push(leaf);
      if (!byPageKey.has(leaf.pageKey)) byPageKey.set(leaf.pageKey, new Set());
      byPageKey.get(leaf.pageKey).add(leaf.pageId);
    }

    const pages = [];
    for (const [pageId, group] of byPageId) {
      const primary = group[0];
      for (const leaf of group.slice(1)) {
        leaf.duplicate = true;
        leaf.duplicateOf = primary.leafId;
      }
      pages.push({
        pageId,
        pageKey: primary.pageKey,
        section: primary.section,
        label: primary.label,
        kind: primary.kind,
        checksum: primary.checksum,
        text: primary.text,
        anchor: primary.anchor,
        anchorPageKey: primary.anchorPageKey,
        primaryLeafId: primary.leafId,
        leafIds: group.map((l) => l.leafId),
        duplicateLeafIds: group.slice(1).map((l) => l.leafId),
        scanOrdinal: 0,
        printOrdinal: null,
      });
    }

    const sectionRank = buildSections(originals);
    const scanSequence = leaves.map((l) => l.leafId);
    pages.forEach((page) => {
      page.scanOrdinal = scanSequence.indexOf(page.primaryLeafId) + 1;
    });
    const printSequence = computePrintSequence(pages, sectionRank);
    pages.forEach((page) => {
      const idx = printSequence.indexOf(page.primaryLeafId);
      page.printOrdinal = idx >= 0 ? idx + 1 : null;
    });

    const pageIdByKey = new Map();
    const conflicts = [];
    for (const [pageKey, pageIdSet] of byPageKey) {
      const ids = [...pageIdSet];
      if (ids.length > 1) {
        const variants = ids.map((id) => {
          const page = pages.find((p) => p.pageId === id);
          return {
            pageId: id,
            label: page.label,
            section: page.section,
            checksum: page.checksum,
            leafIds: page.leafIds,
          };
        });
        conflicts.push({
          pageKey,
          label: variants[0].label,
          section: variants[0].section,
          reason: 'same_page_number_different_checksum',
          variants,
        });
        pageIdByKey.set(pageKey, ids);
      } else {
        pageIdByKey.set(pageKey, ids);
      }
    }

    return {
      captureVersionId,
      itemId: item.itemId,
      n,
      createdAt: nowIso(),
      reason,
      mode,
      originalsDigest: shortHash(stableStringify(originals), 16),
      leaves,
      pages,
      conflicts,
      feeds: {
        scan: {
          feedId: `FEED-SCAN-${captureVersionId}`,
          itemId: item.itemId,
          captureVersionId,
          order: 'sheet',
          label: '归档服务 A：扫描页序',
          sequence: scanSequence,
          policy: '保留每一张底片；校验和相同的重复帧折叠到同一 pageId，主本保留。',
        },
        print: {
          feedId: `FEED-PRINT-${captureVersionId}`,
          itemId: item.itemId,
          captureVersionId,
          order: 'printed',
          label: '归档服务 B：印刷页码',
          sequence: printSequence,
          policy: '按章/页码排序；相同 pageId 的重复底片去重；无页码勘误按锚点插入。',
        },
      },
    };
  }

  _buildMapping(item, capture) {
    // Compare against the most recently confirmed mapping for this item, even
    // after a newer capture cleared activeMappingId. pageIds are content
    // addressed, so a page whose checksum survived keeps its identity.
    const previous = [...item.mappings].reverse().find((m) => m.status === 'confirmed') || null;
    const previousByPageId = new Map((previous?.entries || []).map((entry) => [entry.pageId, entry]));
    const printLeafIds = new Set(capture.feeds.print.sequence);
    const scanLeafIds = new Set(capture.feeds.scan.sequence);
    const entries = [];
    const issues = [];

    for (const page of capture.pages) {
      const inScan = scanLeafIds.has(page.primaryLeafId);
      const inPrint = printLeafIds.has(page.primaryLeafId);
      const prior = previousByPageId.get(page.pageId);
      const reused = Boolean(prior && prior.checksum === page.checksum);
      let status = 'matched';
      if (!inScan && inPrint) status = 'only-print';
      if (inScan && !inPrint) status = 'only-scan';
      if (!inScan && !inPrint) status = 'missing-both';
      entries.push({
        entryId: `ENT-${page.pageId}`,
        pageId: page.pageId,
        pageKey: page.pageKey,
        section: page.section,
        label: page.label,
        kind: page.kind,
        checksum: page.checksum,
        scanLeafId: inScan ? page.primaryLeafId : null,
        printLeafId: inPrint ? page.primaryLeafId : null,
        scanOrdinal: page.scanOrdinal,
        printOrdinal: page.printOrdinal,
        duplicateLeafIds: page.duplicateLeafIds,
        status,
        reused,
        priorMappingId: reused ? previous.mappingId : null,
      });
      if (status !== 'matched') {
        issues.push({
          code: status === 'only-scan' ? 'missing_in_print_feed' : status === 'only-print' ? 'missing_in_scan_feed' : 'missing_in_both_feeds',
          pageKey: page.pageKey,
          pageId: page.pageId,
          label: page.label,
          section: page.section,
          message:
            status === 'only-scan'
              ? '扫描页序中有此页，印刷页码 feed 中没有对应页'
              : status === 'only-print'
                ? '印刷页码 feed 中有此页，扫描页序中没有对应页'
                : '两套 feed 都没有此页',
        });
      }
    }

    for (const conflict of capture.conflicts) {
      issues.push({
        code: 'same_page_number_conflict',
        pageKey: conflict.pageKey,
        label: conflict.label,
        section: conflict.section,
        variants: conflict.variants,
        message: `页号「${conflict.section ? conflict.section + ' ' : ''}${conflict.label}」出现多个校验和，必须人工裁定，不能自动确认`,
      });
    }

    const onlyScan = entries.filter((e) => e.status === 'only-scan').length;
    const onlyPrint = entries.filter((e) => e.status === 'only-print').length;
    const matched = entries.filter((e) => e.status === 'matched').length;
    const counts = {
      total: entries.length,
      matched,
      onlyScan,
      onlyPrint,
      conflicts: capture.conflicts.length,
      reused: entries.filter((e) => e.reused).length,
      fresh: entries.filter((e) => !e.reused).length,
      duplicates: entries.filter((e) => e.duplicateLeafIds.length > 0).length,
      errata: entries.filter((e) => e.kind === 'errata').length,
    };
    return {
      itemId: item.itemId,
      captureVersionId: capture.captureVersionId,
      entries,
      counts,
      issues,
      confirmable: entries.length > 0 && issues.length === 0,
      previousMappingId: previous?.mappingId || null,
    };
  }

  _docFor(capture, page, item, reused, docId = page.pageId) {
    const leaf = capture.leaves.find((l) => l.leafId === page.primaryLeafId);
    return {
      docId,
      pageId: page.pageId,
      pageKey: page.pageKey,
      itemId: item.itemId,
      itemTitle: item.title,
      section: page.section || '',
      label: page.label,
      kind: page.kind,
      checksum: page.checksum,
      text: page.text,
      captureVersionId: capture.captureVersionId,
      leafId: leaf.leafId,
      sheet: leaf.sheet,
      scanOrdinal: page.scanOrdinal,
      printOrdinal: page.printOrdinal,
      reused: Boolean(reused),
    };
  }

  _snippet(text, tokens) {
    const normalized = normalizeText(text);
    const lower = normalized.toLowerCase();
    let at = -1;
    for (const token of tokens) {
      const idx = lower.indexOf(token);
      if (idx >= 0 && (at < 0 || idx < at)) at = idx;
    }
    if (at < 0) return truncate(normalized, 90);
    const start = Math.max(0, at - 20);
    return `${start > 0 ? '…' : ''}${normalized.slice(start, start + 90)}${start + 90 < normalized.length ? '…' : ''}`;
  }

  _notesFor(action, result, error) {
    if (error) {
      const notes = [`操作被拒绝：${error.message}`];
      if (error.details?.blockers) {
        for (const blocker of error.details.blockers) notes.push(`阻塞 ${blocker.itemId}: ${blocker.message}`);
      }
      if (error.details?.issues) {
        for (const issue of error.details.issues.slice(0, 8)) notes.push(`未确认项：${issue.message}`);
      }
      return notes;
    }
    const notes = [];
    if (action === 'compare-index' && result) {
      for (const check of result.checks) notes.push(`[${check.status}] ${check.id}: ${check.detail}`);
    }
    if (action === 'publish-index' && result) {
      notes.push(
        result.noop
          ? '本次换版为无变化：未产生新索引版本。'
          : `索引 ${result.previousVersionId || '(无)'} → ${result.indexVersionId}，复用 ${result.reusedDocs} 篇，新建 ${result.rebuiltDocs} 篇。`,
      );
    }
    if (action === 'confirm-mapping' && result) {
      notes.push(`对应关系 ${result.mappingId}：复用 ${result.counts.reused} 页，新页 ${result.counts.fresh} 页。`);
    }
    if (result?.note) notes.push(result.note);
    return notes;
  }
}

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details || null;
  return err;
}

module.exports = {
  ArchiveEngine,
  FEED_PRINT,
  FEED_SCAN,
  computePrintSequence,
  pageIdOf,
  pageKeyOf,
  summarizeState,
};
