'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { nowIso } = require('./util');

const STATE_VERSION = 1;

function emptyMetrics() {
  return {
    captureRuns: 0,
    captureVersions: 0,
    errataInsertions: 0,
    mappingConfirmations: 0,
    mappingReusedPages: 0,
    mappingRekeyedPages: 0,
    indexPublishAttempts: 0,
    indexPublishRejections: 0,
    indexVersionsPublished: 0,
    indexNoopPublishes: 0,
    searches: 0,
    searchHits: 0,
    citationsCreated: 0,
    citationsReused: 0,
  };
}

function emptyState() {
  return {
    stateVersion: STATE_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seq: {
      capture: 0,
      mapping: 0,
      index: 0,
      citation: 0,
      operation: 0,
      errata: 0,
    },
    items: [],
    index: { versions: [], activeVersionId: null },
    citations: [],
    ops: [],
    lastOperationId: null,
    metrics: emptyMetrics(),
  };
}

function assertState(state) {
  if (!state || typeof state !== 'object') throw new Error('state.json 不是对象');
  if (state.stateVersion !== STATE_VERSION) {
    throw new Error(`state.json 版本 ${state.stateVersion} 与当前 ${STATE_VERSION} 不兼容；请删除本地状态后重启`);
  }
  if (!Array.isArray(state.items) || !Array.isArray(state.citations) || !Array.isArray(state.ops)) {
    throw new Error('state.json 结构不完整');
  }
  if (!state.index || !Array.isArray(state.index.versions)) {
    throw new Error('state.json 缺少索引区');
  }
  if (!state.metrics) state.metrics = emptyMetrics();
}

/**
 * Small synchronous file store. Single local operator; no locking needed.
 * Pass persistPath = null for an in-memory store (tests).
 */
class ArchiveStore {
  constructor(persistPath = null) {
    this.persistPath = persistPath;
    this.state = this.load();
  }

  load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return emptyState();
    const raw = fs.readFileSync(this.persistPath, 'utf8');
    if (!raw.trim()) return emptyState();
    const state = JSON.parse(raw);
    assertState(state);
    return state;
  }

  save() {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.persistPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.persistPath);
  }

  /**
   * Run a mutation. State is persisted even when the mutation rejects, so a
   * refused index switch still leaves an auditable operation and counter.
   */
  run(mutator) {
    try {
      return mutator(this.state);
    } finally {
      this.state.updatedAt = nowIso();
      this.save();
    }
  }

  reset() {
    this.state = emptyState();
    this.save();
    return this.state;
  }
}

module.exports = {
  ArchiveStore,
  emptyMetrics,
  emptyState,
  STATE_VERSION,
};
