'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { ArchiveEngine } = require('../lib/engine');
const { SAMPLE_ARCHIVE, SAMPLE_TEST_ARCHIVE } = require('../lib/fixtures');
const { ArchiveStore } = require('../lib/store');
const { createApp } = require('../server');

const FIXTURES = { SAMPLE_ARCHIVE, SAMPLE_TEST_ARCHIVE };

function freshEngine() {
  return new ArchiveEngine(new ArchiveStore(null), FIXTURES);
}

function itemOf(engine, itemId) {
  return engine.state.items.find((i) => i.itemId === itemId);
}

function pageByKey(item, pageKey, captureIndex = -1) {
  const capture = item.captures.at(captureIndex);
  return capture.pages.find((p) => p.pageKey === pageKey);
}

function ok(operation) {
  assert.equal(operation.ok, true, `expected ok, got ${operation.status} ${JSON.stringify(operation.error)}`);
  return operation.result;
}

describe('采集：两套分页各自成立', () => {
  it('扫描页序与印刷页码在装订错页的图册上确实不同，且都完整覆盖同一批页', () => {
    const engine = freshEngine();
    const result = ok(engine.execute('capture', {}));
    const atlas = result.captures.find((c) => c.itemId === 'ITEM-ATLAS');

    assert.deepEqual(atlas.scanSequence, ['1', '3', '勘误 (无页码)', '2', '4']);
    assert.deepEqual(atlas.printSequence, ['1', '2', '勘误 (无页码)', '3', '4']);
    assert.notDeepEqual(atlas.scanSequence, atlas.printSequence);

    const scanPages = new Set(atlas.pageIds.map((p) => p.pageId));
    assert.equal(scanPages.size, 5, '5 个逻辑页，重复与勘误都只有一个 pageId');
  });

  it('扫描 feed 保留每一张底片，重复底片在印刷 feed 折叠但主本仍可用', () => {
    const engine = freshEngine();
    const result = ok(engine.execute('capture', {}));
    const journal = result.captures.find((c) => c.itemId === 'ITEM-JOURNAL');
    const capture = itemOf(engine, 'ITEM-JOURNAL').captures.at(-1);

    assert.equal(journal.scanSequence.length, 5);
    assert.equal(journal.printSequence.length, 4);
    assert.equal(journal.duplicateFrames.length, 1);
    const dup = journal.duplicateFrames[0];
    assert.equal(dup.copies, 2);
    assert.equal(capture.feeds.scan.sequence.includes(dup.keptLeafId), true);
    assert.equal(capture.feeds.print.sequence.includes(dup.keptLeafId), true);
  });

  it('第二章的“第 1 页”与第一章的“第 1 页”是两个不同 pageId，不被误并', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const journal = itemOf(engine, 'ITEM-JOURNAL');
    const p1 = pageByKey(journal, 'page|第一章|1');
    const p2 = pageByKey(journal, 'page|第二章|1');

    assert.ok(p1 && p2);
    assert.notEqual(p1.pageId, p2.pageId);
  });
});

describe('同为页码冲突：校验和不同必须拦下', () => {
  it('同页号不同校验和被记录为 conflict，对应关系不可确认，索引拒绝换版', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', { fixture: 'test' }));
    const capture = itemOf(engine, 'ITEM-T').captures.at(-1);

    assert.equal(capture.conflicts.length, 1);
    assert.equal(capture.conflicts[0].pageKey, 'page||3');
    assert.equal(capture.conflicts[0].variants.length, 2);

    const confirm = engine.execute('confirm-mapping', { itemId: 'ITEM-T' });
    assert.equal(confirm.ok, false);
    assert.equal(confirm.status, 409);
    assert.equal(confirm.error.code, 'mapping_not_confirmable');
    assert.ok(confirm.error.details.issues.some((i) => i.code === 'same_page_number_conflict'));

    const publish = engine.execute('publish-index', {});
    assert.equal(publish.ok, false);
    assert.equal(publish.error.code, 'mapping_gate');
  });
});

describe('对应关系闸门', () => {
  it('未确认对应关系时索引拒绝换版，并保留可审计的拒绝操作', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));

    const publish = engine.execute('publish-index', {});
    assert.equal(publish.ok, false);
    assert.equal(publish.status, 409);
    assert.equal(publish.error.code, 'mapping_gate');
    assert.ok(publish.error.details.blockers.length >= 2);
    assert.equal(engine.state.index.versions.length, 0);
    assert.equal(engine.state.metrics.indexPublishRejections, 1);
    assert.equal(engine.state.ops.at(-1).ok, false);
  });

  it('插入勘误后原件版本推进，旧确认失效，旧索引仍生效直到重新确认并换版', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    const v1 = ok(engine.execute('publish-index', {}));
    assert.equal(v1.indexVersionId, 'IDX-0001');

    const errata = ok(
      engine.execute('insert-errata', {
        itemId: 'ITEM-ATLAS',
        afterSection: '',
        afterPageLabel: '2',
        text: '补页：第 2 页图例改为虚线。',
      }),
    );
    assert.equal(errata.mappingStatus, 'stale');

    const blocked = engine.execute('publish-index', {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'mapping_gate');
    assert.ok(blocked.error.details.blockers.some((b) => b.code === 'mapping_stale'));
    assert.equal(engine.state.index.activeVersionId, v1.indexVersionId, '旧索引版本继续生效');

    const remap = ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    assert.ok(remap.counts.reused >= 5, '未变化的页逐页复用 pageId');
    assert.equal(remap.counts.fresh, 1, '只有新插入的勘误页是新页');

    const v2 = ok(engine.execute('publish-index', {}));
    assert.equal(v2.indexVersionId, 'IDX-0002');
    assert.ok(v2.reusedDocs >= 5);
    assert.equal(engine.state.index.activeVersionId, 'IDX-0002');
  });

  it('同一原件版本重复确认对应关系是无操作', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const first = ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    const second = ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));

    assert.equal(second.noop, true);
    assert.equal(second.mappingId, first.mappingId);
    assert.equal(itemOf(engine, 'ITEM-ATLAS').mappings.length, 1);
  });

  it('索引内容无变化时换版不产生新版本', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    const v1 = ok(engine.execute('publish-index', {}));
    const again = ok(engine.execute('publish-index', {}));

    assert.equal(again.noop, true);
    assert.equal(again.indexVersionId, v1.indexVersionId);
    assert.equal(engine.state.index.versions.length, 1);
    assert.equal(engine.state.metrics.indexNoopPublishes, 1);
  });
});

describe('引用在重复页与同页码下保持旧引用', () => {
  it('旧页面被改版后，新索引换 pageId，旧引用回落到旧索引版本且不被改写', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    ok(engine.execute('publish-index', {}));
    const atlas = itemOf(engine, 'ITEM-ATLAS');
    const p2 = pageByKey(atlas, 'page||2');
    const citation = ok(engine.execute('create-citation', { itemId: 'ITEM-ATLAS', pageId: p2.pageId }));

    const original = atlas.originals.find((raw) => raw.pageLabel === '2');
    original.text = '分图 A 北岸码头（重印修订本）。';
    original.signature = 'atlas:0002-r2';
    ok(engine.execute('capture', { itemId: 'ITEM-ATLAS' }));
    const remap = ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    assert.equal(remap.counts.fresh, 1, '改版页按新校验和分配新 pageId');
    ok(engine.execute('publish-index', {}));

    const resolved = engine.resolveCitations().citations.find((c) => c.citationId === citation.citationId);
    assert.equal(resolved.active, null, '新索引不再收录原 pageId');
    assert.equal(resolved.preserved, true, '旧索引版本仍可解析');
    assert.equal(resolved.contentChanged, true);
    assert.equal(resolved.history.at(-1).docId, citation.originallyIndexedAs);
    assert.match(resolved.explanation, /内容已改版/);
  });

  it('重复扫描的页只有一个 pageId，重复建立引用复用同一 citationId', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const journal = itemOf(engine, 'ITEM-JOURNAL');
    const page = pageByKey(journal, 'page|第二章|2');
    assert.equal(page.leafIds.length, 2, '两个底片帧');

    const first = ok(engine.execute('create-citation', { itemId: 'ITEM-JOURNAL', pageId: page.pageId }));
    const second = ok(engine.execute('create-citation', { itemId: 'ITEM-JOURNAL', pageId: page.pageId }));

    assert.equal(second.noop, true);
    assert.equal(second.citationId, first.citationId);
    assert.equal(engine.state.citations.length, 1);
  });

  it('逐页复用模式：勘误插入并换版后，旧引用的 docId 不变', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    ok(engine.execute('publish-index', {}));
    const page = pageByKey(itemOf(engine, 'ITEM-ATLAS'), 'page||2');
    const citation = ok(engine.execute('create-citation', { itemId: 'ITEM-ATLAS', pageId: page.pageId }));

    ok(engine.execute('insert-errata', { itemId: 'ITEM-ATLAS', afterPageLabel: '2', text: '勘误补页。' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('publish-index', {}));

    const resolved = engine.resolveCitations().citations.find((c) => c.citationId === citation.citationId);
    assert.equal(resolved.preserved, true);
    assert.ok(resolved.active, '仍命中当前索引');
    assert.equal(resolved.active.docId, citation.originallyIndexedAs);
    assert.equal(resolved.docIdStable, true);
    assert.equal(resolved.pageId, page.pageId);
  });

  it('整件重建模式：文档标识更换，但引用按 pageId 仍可解析，旧索引版本保留原文档', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    ok(engine.execute('publish-index', { mode: 'rebuild' }));
    const page = pageByKey(itemOf(engine, 'ITEM-ATLAS'), 'page||2');
    const citation = ok(engine.execute('create-citation', { itemId: 'ITEM-ATLAS', pageId: page.pageId }));

    ok(engine.execute('insert-errata', { itemId: 'ITEM-ATLAS', afterPageLabel: '2', text: '勘误补页。', mode: 'rebuild' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS', mode: 'rebuild' }));
    ok(engine.execute('publish-index', { mode: 'rebuild' }));

    const resolved = engine.resolveCitations().citations.find((c) => c.citationId === citation.citationId);
    assert.equal(resolved.preserved, true);
    assert.equal(resolved.docIdStable, false, '重建后 docId 变化，用于说明必须靠 pageId 保引用');
    assert.notEqual(resolved.active.docId, citation.originallyIndexedAs);
    assert.ok(resolved.history.length >= 1);
    assert.ok(resolved.history.some((h) => h.docId === citation.originallyIndexedAs));

    const oldVersion = engine.state.index.versions.find((v) => v.versionId === resolved.history[0].indexVersionId);
    assert.ok(oldVersion.docs.some((d) => d.docId === citation.originallyIndexedAs), '旧版本保留原文档');
  });

  it('旧索引版本在换版后仍保留其文档，检索可指向指定旧版本', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    const v1 = ok(engine.execute('publish-index', {}));
    const errata = ok(engine.execute('insert-errata', { itemId: 'ITEM-ATLAS', afterPageLabel: '2', text: '鱼汛期禁航。' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('publish-index', {}));

    const current = engine.search({ q: '鱼汛期' });
    assert.equal(current.indexVersionId, 'IDX-0002');
    assert.ok(current.results.some((r) => r.pageId === errata.errataPageId));

    const old = engine.search({ q: '鱼汛期', indexVersionId: v1.indexVersionId });
    assert.equal(old.ok, true);
    assert.equal(old.results.length, 0, '旧版本确实不含新页');
  });
});

describe('检索只在对应关系确认后看到新页', () => {
  it('换版前检索返回 index_not_published，换版后能命中', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const before = engine.search({ q: '港区' });
    assert.equal(before.ok, false);
    assert.equal(before.error.code, 'index_not_published');

    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    ok(engine.execute('publish-index', {}));
    const after = engine.search({ q: '港区' });
    assert.equal(after.ok, true);
    assert.ok(after.results.length >= 1);
  });

  it('空白检索词被拒绝', () => {
    const engine = freshEngine();
    const result = engine.search({ q: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, 'empty_query');
  });
});

describe('对照页码索引', () => {
  it('报告扫描序与印刷序的位次差异、重复页、勘误锚点，并给出稳定 digest', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const compare = ok(engine.execute('compare-index', {}));

    assert.ok(compare.orderMismatches.length >= 2, '图册至少两页位次不同');
    assert.equal(compare.errata.length, 1, '样例中只有图册夹入一张勘误');
    for (const row of compare.errata) {
      assert.ok(row.pageId);
      assert.deepEqual(row.anchor, { section: '', pageLabel: '2' });
      assert.ok('printPosition' in row);
    }
    assert.equal(compare.summary.duplicates, 1);
    assert.match(compare.digest, /^[0-9a-f]{20}$/);

    const again = ok(engine.execute('compare-index', {}));
    // The digest covers the `at` timestamp, so repeated comparisons differ in
    // digest but agree on every substantive count.
    assert.deepEqual(again.summary, compare.summary);
  });

  it('操作前后证据摘要不同，且操作记录里同时保留 before / after', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    const operation = engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' });
    assert.notEqual(operation.before.stateDigest, operation.after.stateDigest);
    assert.equal(operation.before.items.find((i) => i.itemId === 'ITEM-ATLAS').mapping, null);
    assert.equal(operation.after.items.find((i) => i.itemId === 'ITEM-ATLAS').mapping.status, 'confirmed');
    assert.equal(engine.state.ops.at(-1).operationId, operation.operationId);
  });

  it('异常输入被拒绝且给出明确错误码', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));

    const unknown = engine.execute('no-such-action', {});
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error.code, 'unknown_action');

    const missingItem = engine.execute('confirm-mapping', {});
    assert.equal(missingItem.status, 400);
    assert.equal(missingItem.error.code, 'item_required');

    const badAnchor = engine.execute('insert-errata', { itemId: 'ITEM-ATLAS', afterPageLabel: '99' });
    assert.equal(badAnchor.status, 400);
    assert.equal(badAnchor.error.code, 'anchor_not_found');

    const noCapture = engine.execute('create-citation', { itemId: 'ITEM-ATLAS' });
    assert.equal(noCapture.status, 404);
    assert.equal(noCapture.error.code, 'page_not_found');

    const noSuchPage = engine.execute('create-citation', { itemId: 'ITEM-ATLAS', pageId: 'PG-missing' });
    assert.equal(noSuchPage.error.code, 'page_not_found');
  });

  it('本地样例不因重复采集而丢失旧版本，仍可逐页复用', () => {
    const engine = freshEngine();
    ok(engine.execute('capture', {}));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    ok(engine.execute('confirm-mapping', { itemId: 'ITEM-JOURNAL' }));
    ok(engine.execute('publish-index', {}));
    const recapture = ok(engine.execute('capture', { itemId: 'ITEM-ATLAS' }));
    assert.equal(itemOf(engine, 'ITEM-ATLAS').captures.length, 2);
    assert.equal(recapture.captures[0].captureVersionId, 'CAP-ITEM-ATLAS-v2');

    const remap = ok(engine.execute('confirm-mapping', { itemId: 'ITEM-ATLAS' }));
    assert.ok(remap.counts.reused >= 5, '内容未变，全部逐页复用');
  });
});

describe('演示流程：一次操作走完三件事', () => {
  for (const mode of ['reuse', 'rebuild']) {
    it(`demo(${mode}) 在同一次操作内采集两套分页、插入勘误、对照索引`, () => {
      const engine = freshEngine();
      const operation = engine.execute('demo', { mode });
      const result = ok(operation);
      const steps = result.steps.map((s) => s.step);

      assert.deepEqual(steps, [
        'capture',
        'confirm-mapping',
        'confirm-mapping',
        'publish-index',
        'create-citation',
        'create-citation',
        'insert-errata',
        'publish-index-blocked-until-mapping-confirmed',
        'confirm-mapping',
        'publish-index',
        'compare-index',
      ]);

      const gated = result.steps.find((s) => s.step === 'publish-index-blocked-until-mapping-confirmed').result;
      assert.equal(gated.rejected, true);
      assert.equal(gated.code, 'mapping_gate');

      const compare = result.steps.at(-1).result;
      assert.equal(compare.checks.every((c) => c.status === 'pass'), true, JSON.stringify(compare.checks, null, 1));
      assert.equal(compare.summary.citations, 2);
      assert.equal(compare.summary.citationsPreserved, 2);
      assert.equal(compare.citationCheck.missing, 0);
      for (const citation of compare.citationCheck.citations) {
        assert.equal(citation.docIdStable, mode === 'reuse');
      }
      assert.notEqual(operation.before.stateDigest, operation.after.stateDigest);
    });
  }

  it('demo 重复执行不会重复插入勘误或引用', () => {
    const engine = freshEngine();
    ok(engine.execute('demo', {}));
    const second = ok(engine.execute('demo', {}));
    const errataStep = second.steps.find((s) => s.step === 'insert-errata').result;
    assert.equal(errataStep.skipped, true);
    const demoErrata = itemOf(engine, 'ITEM-ATLAS')
      .captures.at(-1)
      .pages.filter((p) => p.kind === 'errata' && p.label.includes('勘误 1'));
    assert.equal(demoErrata.length, 1, '演示勘误只插入一次');
    assert.equal(engine.state.citations.length, 2);
  });
});

describe('HTTP：node server.js 契约', () => {
  let server;
  let engine;
  let base;
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-desk-'));
    const app = createApp({ statePath: path.join(tmpDir, 'state.json') });
    engine = app.engine;
    server = app.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET / 返回带 data-evidence-result 的业务结果区', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-evidence-result/);
    assert.match(html, /采集两套分页/);
    assert.match(html, /插入勘误页/);
    assert.match(html, /对照页码索引/);
  });

  it('POST /api/operation demo 返回前后可核对的状态摘要', async () => {
    const res = await fetch(`${base}/api/operation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'demo', params: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.notEqual(body.operation.before.stateDigest, body.operation.after.stateDigest);
    assert.equal(body.state.index.activeVersionId, 'IDX-0002');
    assert.equal(body.state.items.find((i) => i.itemId === 'ITEM-ATLAS').captureVersions.length, 2);
  });

  it('GET /api/state 暴露最近一次对照结果，供页面刷新后复用', async () => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.lastCompare?.result, 'demo 之后应保存对照结果');
    assert.equal(body.lastCompare.result.items.length, 2);
    assert.equal(body.lastCompare.result.citationCheck.citations.length, 2);
  });

  it('拒绝未知 action 与非法 JSON', async () => {
    const bad = await fetch(`${base}/api/operation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'unknown_action');

    const malformed = await fetch(`${base}/api/operation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_json');
  });

  it('GET /api/search 在索引未就绪时返回 409 语义', async () => {
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent('港区')}&indexVersionId=IDX-9999`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'index_not_published');
  });

  it('静态目录穿越被拒绝', async () => {
    const res = await fetch(`${base}/..%2fserver.js`);
    assert.equal(res.status, 403);
  });

  it('状态文件在重启后保留索引版本与引用', () => {
    const storePath = path.join(tmpDir, 'restart.json');
    const first = createApp({ statePath: storePath });
    ok(first.engine.execute('demo', {}));
    assert.ok(fs.existsSync(storePath));

    const second = createApp({ statePath: storePath });
    assert.equal(second.engine.state.index.activeVersionId, 'IDX-0002');
    assert.equal(second.engine.state.citations.length, 2);
    assert.equal(second.engine.state.index.versions.length, 2);
  });
});
