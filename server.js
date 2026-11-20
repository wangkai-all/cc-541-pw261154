'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { ArchiveEngine } = require('./lib/engine');
const { SAMPLE_ARCHIVE, SAMPLE_TEST_ARCHIVE } = require('./lib/fixtures');
const { ArchiveStore } = require('./lib/store');

const HOST = '127.0.0.1';
const RAW_PORT = process.env.PORT ?? '3000';
const PORT = Number.parseInt(RAW_PORT, 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || String(PORT) !== String(RAW_PORT).trim()) {
  process.stderr.write(`PORT 必须是 1–65535 的整数，收到：${JSON.stringify(RAW_PORT)}\n`);
  process.exit(1);
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_PATH = process.env.STATE_PATH
  ? path.resolve(process.env.STATE_PATH)
  : path.join(__dirname, 'data', 'state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400, code: 'body_not_object' }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createApp(options = {}) {
  const store = options.store || new ArchiveStore(options.statePath === undefined ? STATE_PATH : options.statePath);
  const engine =
    options.engine || new ArchiveEngine(store, { SAMPLE_ARCHIVE, SAMPLE_TEST_ARCHIVE });

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'internal_error', message: '服务内部错误' },
        });
      } else {
        res.end();
      }
      process.stderr.write(`request failed: ${err.stack || err}\n`);
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, { ok: true, ...engine.publicState() });
    }
    if (req.method === 'GET' && url.pathname === '/api/citations') {
      return sendJson(res, 200, engine.resolveCitations());
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      return sendJson(res, 200, engine.search(Object.fromEntries(url.searchParams)));
    }
    if (req.method === 'POST' && url.pathname === '/api/operation') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: { code: err.code || 'bad_request', message: err.message },
        });
      }
      if (!body.action) {
        return sendJson(res, 400, {
          ok: false,
          error: { code: 'action_required', message: '请求体缺少 action' },
        });
      }
      const operation = engine.execute(body.action, body.params || {});
      return sendJson(res, operation.ok ? 200 : operation.status, {
        ok: operation.ok,
        ...(operation.ok ? {} : { error: operation.error }),
        operation,
        state: engine.publicState(),
      });
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'not_found', message: `未知接口 ${url.pathname}` },
      });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
    res.end('method not allowed');
  }

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, engine, store };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `归档分页校对台已启动：http://${HOST}:${PORT}\n` +
        `状态文件：${STATE_PATH}\n` +
        `本地样例，不连接外部服务。\n`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
