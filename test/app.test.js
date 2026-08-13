'use strict';

// HTTP-gedrag van de service zonder echte browser: auth, grenzen en health zijn
// eigenschappen van de app, niet van Chromium. De echte render zit in scripts/acceptance.sh.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const TOKEN = 'a'.repeat(40);
const STIL = { info() {}, warn() {}, error() {} };

function nepBrowserManager({ ok = true, rendert = true } = {}) {
  return {
    async health() {
      return ok
        ? { ok: true, state: 'gereed', connected: true, pid: 1, restarts: 0, last_error: null, version: 'Nep/1.0' }
        : { ok: false, state: 'herstartend', connected: false, pid: null, restarts: 1, last_error: 'gecrasht', version: null };
    },
    get() {
      if (!rendert) throw Object.assign(new Error('browser niet beschikbaar'), { code: 'BROWSER_UNAVAILABLE' });
      return { async newPage() { throw new Error('niet gebruikt in deze test'); } };
    },
  };
}

async function metServer(browserManager, fn, envExtra = {}) {
  const config = loadConfig({ RENDER_SERVICE_TOKEN: TOKEN, ...envExtra });
  const app = createApp({ config, browserManager, logger: STIL });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const basis = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(basis);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /generate zonder token geeft 401 en geen PDF-bytes', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const res = await fetch(`${basis}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>hallo</p>' }),
    });
    assert.equal(res.status, 401);
    assert.ok(!res.headers.get('content-type')?.includes('pdf'));
    const body = await res.text();
    assert.ok(!body.startsWith('%PDF'));
    assert.equal(JSON.parse(body).error, 'unauthorized');
  });
});

test('een fout token geeft 401', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const res = await fetch(`${basis}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-render-token': 'b'.repeat(40) },
      body: JSON.stringify({ html: '<p>hallo</p>' }),
    });
    assert.equal(res.status, 401);
  });
});

test('auth komt vóór het parsen: onparsebare body zonder token geeft 401, geen 400', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const res = await fetch(`${basis}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{dit is geen json',
    });
    assert.equal(res.status, 401);
  });
});

test('met token maar zonder html geeft 400', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const res = await fetch(`${basis}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-render-token': TOKEN },
      body: JSON.stringify({ bestandsnaam: 'leeg' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request');
  });
});

test('een te grote body geeft 413, geen crash', async () => {
  await metServer(
    nepBrowserManager(),
    async (basis) => {
      const res = await fetch(`${basis}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-token': TOKEN },
        body: JSON.stringify({ html: 'x'.repeat(5000) }),
      });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).error, 'payload_too_large');
    },
    { MAX_BODY_BYTES: '2048' },
  );
});

test('zonder werkende browser geeft /generate 503 met Retry-After', async () => {
  await metServer(nepBrowserManager({ ok: false, rendert: false }), async (basis) => {
    const res = await fetch(`${basis}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-render-token': TOKEN },
      body: JSON.stringify({ html: '<p>hallo</p>' }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.equal((await res.json()).error, 'browser_unavailable');
  });
});

test('GET /health is ongeauthenticeerd en geeft 200 bij een gezonde browser', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const res = await fetch(`${basis}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.browser.connected, true);
    assert.equal(body.browser.version, 'Nep/1.0');
  });
});

test('GET /health geeft 503 zolang de browser weg is', async () => {
  await metServer(nepBrowserManager({ ok: false }), async (basis) => {
    const res = await fetch(`${basis}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.browser.state, 'herstartend');
  });
});

test('/health lekt het token niet', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    const body = await (await fetch(`${basis}/health`)).text();
    assert.ok(!body.includes(TOKEN));
  });
});

test('een onbekend eindpunt geeft 404 achter auth', async () => {
  await metServer(nepBrowserManager(), async (basis) => {
    assert.equal((await fetch(`${basis}/bestaat-niet`)).status, 401);
    const res = await fetch(`${basis}/bestaat-niet`, { headers: { 'x-render-token': TOKEN } });
    assert.equal(res.status, 404);
  });
});
