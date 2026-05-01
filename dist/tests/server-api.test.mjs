import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

let serverProc;
let baseUrl;
let serverStdout = '';
let serverStderr = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : null;
      srv.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error('Failed to allocate free port'));
        resolve(port);
      });
    });
  });
}

async function waitForServerReady(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/status`);
      if (res.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms\nstdout:\n${serverStdout}\nstderr:\n${serverStderr}`);
}

async function jsonRequest(route, init = {}) {
  const res = await fetch(`${baseUrl}${route}`, init);
  const body = await res.json();
  return { res, body };
}

before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (chunk) => {
    serverStdout += chunk.toString();
  });
  serverProc.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString();
  });

  await waitForServerReady(baseUrl);
});

after(async () => {
  if (!serverProc || serverProc.exitCode !== null) return;

  const exitPromise = new Promise((resolve) => {
    serverProc.once('exit', resolve);
  });
  serverProc.kill('SIGTERM');
  await Promise.race([
    exitPromise,
    sleep(3000).then(() => {
      if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
    }),
  ]);
});

describe('server API endpoints', () => {
  it('GET /api/status returns health and feature flags', async () => {
    const { res, body } = await jsonRequest('/api/status');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'live');
    assert.equal(body.features.sse, true);
    assert.equal(body.features.runCancellation, true);
    assert.equal(typeof body.activeRuns, 'number');
    assert.equal(typeof body.sseClients, 'number');
    assert.equal(typeof body.browserPool.headless, 'boolean');
    assert.equal(typeof body.browserPool.headed, 'boolean');
  });

  it('GET /api/runs returns an array', async () => {
    const { res, body } = await jsonRequest('/api/runs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /api/record-flow/status returns inactive when no recording exists', async () => {
    const { res, body } = await jsonRequest('/api/record-flow/status');
    assert.equal(res.status, 200);
    assert.deepEqual(body, { active: false });
  });

  it('GET /api/events responds as an SSE stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const chunk = await Promise.race([
      reader.read(),
      sleep(2000).then(() => ({ done: true, value: null })),
    ]);
    const text = chunk?.value ? new TextDecoder().decode(chunk.value) : '';
    assert.ok(text.includes(': connected'));
    controller.abort();
  });

  it('GET /api/vpn-status returns a JSON payload', async () => {
    const { res, body } = await jsonRequest('/api/vpn-status');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.vpn, 'object');
    assert.equal(typeof body.vpn.connected, 'boolean');
    assert.equal(typeof body.vpn.rotationEnabled, 'boolean');
    assert.equal(typeof body.vpn.configCount, 'number');
  });
});

describe('server error handling', () => {
  it('POST /api/login-check returns 400 for missing required fields', async () => {
    const { res, body } = await jsonRequest('/api/login-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Missing username, password, or loginUrl/i);
  });

  it('POST /api/card-check returns 400 for missing required fields', async () => {
    const { res, body } = await jsonRequest('/api/card-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Missing card fields or ppsrUrl/i);
  });

  it('POST /api/record-flow returns 400 when loginUrl is missing', async () => {
    const { res, body } = await jsonRequest('/api/record-flow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Missing loginUrl/i);
  });

  it('POST /api/login-check rejects unsupported loginUrl schemes', async () => {
    const { res, body } = await jsonRequest('/api/login-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'user@example.com',
        password: 'pw',
        loginUrl: 'javascript:alert(1)',
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Invalid loginUrl/i);
  });

  it('POST /api/card-check rejects unsupported ppsrUrl schemes', async () => {
    const { res, body } = await jsonRequest('/api/card-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        number: '4111111111111111',
        mm: '01',
        yy: '30',
        cvv: '123',
        ppsrUrl: 'ftp://example.com',
      }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Invalid ppsrUrl/i);
  });

  it('POST /api/record-flow rejects unsupported loginUrl schemes', async () => {
    const { res, body } = await jsonRequest('/api/record-flow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginUrl: 'file:///tmp/foo.html' }),
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /Invalid loginUrl/i);
  });

  it('POST /api/cancel/:runId returns 404 for unknown run ids', async () => {
    const { res, body } = await jsonRequest('/api/cancel/not-a-real-run-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 404);
    assert.equal(body.error, 'Run not found');
  });

  it('returns 400 for malformed JSON payloads', async () => {
    const res = await fetch(`${baseUrl}/api/login-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(res.status, 400);
  });
});
