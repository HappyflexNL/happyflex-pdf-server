#!/usr/bin/env node
// Acceptatieharnas voor de renderservice — draait tegen een écht draaiende service met een
// echte browser. Start de service zelf, meet, en sluit hem weer af.
//
//   node scripts/acceptance.mjs
//
// Vereist: pdftotext (poppler) op PATH, en een Chrome die puppeteer kan vinden.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TOKEN = randomBytes(24).toString('hex');
const PORT = 3111;
const BASIS = `http://127.0.0.1:${PORT}`;
const MARKERING = 'HAPPYFLEX-RENDER-BEWIJS-7391';
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif}</style></head>
<body><h1>${MARKERING}</h1><p>Regel met tekstlaag, geen raster.</p></body></html>`;

const werkmap = mkdtempSync(join(tmpdir(), 'hf-render-accept-'));
const resultaten = [];
let server;

function meld(naam, gehaald, detail) {
  resultaten.push({ naam, gehaald, detail });
  console.log(`${gehaald ? '  OK  ' : ' FOUT '} ${naam}\n        ${detail}`);
}

const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

/** RSS van de serverprocesboom (node + chrome + renderers), in MB. */
function rssBoomMb(rootPid) {
  const uitvoer = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString().trim().split('\n');
  const kinderen = new Map();
  const rss = new Map();
  for (const regel of uitvoer) {
    const [pid, ppid, kb] = regel.trim().split(/\s+/).map(Number);
    if (!kinderen.has(ppid)) kinderen.set(ppid, []);
    kinderen.get(ppid).push(pid);
    rss.set(pid, kb);
  }
  let totaal = 0;
  const stapel = [rootPid];
  while (stapel.length) {
    const pid = stapel.pop();
    totaal += rss.get(pid) ?? 0;
    stapel.push(...(kinderen.get(pid) ?? []));
  }
  return totaal / 1024;
}

async function health() {
  const res = await fetch(`${BASIS}/health`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function genereer({ token = TOKEN, body, headers = {} } = {}) {
  return fetch(`${BASIS}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-render-token': token } : {}), ...headers },
    body: JSON.stringify(body ?? { html: FIXTURE, bestandsnaam: 'acceptatie test' }),
  });
}

async function wachtTot(voorwaarde, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const einde = Date.now() + timeoutMs;
  while (Date.now() < einde) {
    try {
      if (await voorwaarde()) return true;
    } catch {
      /* nog niet bereikbaar */
    }
    await slaap(intervalMs);
  }
  return false;
}

async function main() {
  console.log(`\nAcceptatie renderservice — werkmap ${werkmap}\n`);

  server = spawn('node', ['pdf-server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, RENDER_SERVICE_TOKEN: TOKEN, PORT: String(PORT), MAX_CONCURRENT_RENDERS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`    [server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`    [server] ${d}`));

  const op = await wachtTot(async () => (await health()).status === 200);
  if (!op) throw new Error('service werd niet gezond binnen de timeout');

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const zonderToken = await genereer({ token: null });
  const tekstZonderToken = await zonderToken.text();
  meld(
    '1. POST /generate zonder token → 401, geen PDF-bytes',
    zonderToken.status === 401 && !tekstZonderToken.includes('%PDF'),
    `status=${zonderToken.status} content-type=${zonderToken.headers.get('content-type')} bevat "%PDF"=${tekstZonderToken.includes('%PDF')}`,
  );

  const foutToken = await genereer({ token: 'fout-token-dat-lang-genoeg-is-1234567890' });
  meld('1b. Fout token → 401', foutToken.status === 401, `status=${foutToken.status}`);

  // ── 2. Render met tekstlaag ────────────────────────────────────────────────
  const goed = await genereer();
  const pdfBytes = Buffer.from(await goed.arrayBuffer());
  const pdfPad = join(werkmap, 'fixture.pdf');
  writeFileSync(pdfPad, pdfBytes);
  execFileSync('pdftotext', [pdfPad, join(werkmap, 'fixture.txt')]);
  const tekst = readFileSync(join(werkmap, 'fixture.txt'), 'utf8');
  meld(
    '2. Met token → 200, application/pdf, pdftotext vindt de fixture-string',
    goed.status === 200 &&
      goed.headers.get('content-type') === 'application/pdf' &&
      pdfBytes.subarray(0, 4).toString() === '%PDF' &&
      tekst.includes(MARKERING),
    `status=${goed.status} type=${goed.headers.get('content-type')} bytes=${pdfBytes.length} ` +
      `magic=${pdfBytes.subarray(0, 4)} pdftotext-bevat-markering=${tekst.includes(MARKERING)}`,
  );
  meld(
    '2b. Bestandsnaam gesaneerd in Content-Disposition',
    goed.headers.get('content-disposition')?.includes('filename="acceptatie_test.pdf"'),
    `content-disposition=${goed.headers.get('content-disposition')}`,
  );

  // ── 3. Browserhergebruik: geen RSS-groei over vijf renders ────────────────
  const gezondheid = await health();
  const browserPid = gezondheid.body.browser.pid;
  const metingen = [];
  for (let i = 1; i <= 5; i += 1) {
    const res = await genereer();
    if (res.status !== 200) throw new Error(`render ${i} gaf ${res.status}`);
    await res.arrayBuffer();
    await slaap(1500); // geef Chromium de tijd om de pagina echt op te ruimen
    metingen.push(Number(rssBoomMb(server.pid).toFixed(1)));
  }
  const verhouding = metingen[4] / metingen[0];
  meld(
    '3. Vijf renders: RSS na de vijfde ≤ 1,5× na de eerste',
    verhouding <= 1.5,
    `RSS per render (MB): ${metingen.join(' → ')} | verhouding 5e/1e = ${verhouding.toFixed(2)}× | ` +
      `browser-pid ongewijzigd = ${(await health()).body.browser.pid === browserPid}`,
  );

  // ── 4. Health volgt de browser, ook na een crash ──────────────────────────
  const voorCrash = await health();
  meld(
    '4a. GET /health → 200 met browserstatus',
    voorCrash.status === 200 && voorCrash.body.browser.connected === true && Boolean(voorCrash.body.browser.version),
    `status=${voorCrash.status} state=${voorCrash.body.browser.state} version=${voorCrash.body.browser.version} pid=${voorCrash.body.browser.pid}`,
  );

  process.kill(voorCrash.body.browser.pid, 'SIGKILL'); // geforceerde browsercrash
  const werdOngezond = await wachtTot(async () => (await health()).status !== 200, { timeoutMs: 10_000, intervalMs: 50 });
  const tijdensHerstel = await health();
  meld(
    '4b. Na geforceerde browsercrash → niet-200 tot de herstart klaar is',
    werdOngezond && tijdensHerstel.status !== 200,
    `status=${tijdensHerstel.status} state=${tijdensHerstel.body?.browser?.state} connected=${tijdensHerstel.body?.browser?.connected}`,
  );

  const tijdensHerstelRender = await genereer();
  meld(
    '4c. Tijdens herstel geeft /generate 503, geen stilstand',
    tijdensHerstelRender.status === 503,
    `status=${tijdensHerstelRender.status} retry-after=${tijdensHerstelRender.headers.get('retry-after')}`,
  );

  const hersteld = await wachtTot(async () => (await health()).status === 200, { timeoutMs: 30_000 });
  const naHerstel = await health();
  meld(
    '4d. Service herstelt zichzelf zonder container-restart',
    hersteld && naHerstel.body.browser.pid !== voorCrash.body.browser.pid,
    `status=${naHerstel.status} nieuwe browser-pid=${naHerstel.body?.browser?.pid} (oud ${voorCrash.body.browser.pid}) restarts=${naHerstel.body?.browser?.restarts}`,
  );

  const naHerstelRender = await genereer();
  meld(
    '4e. Render werkt weer na herstel',
    naHerstelRender.status === 200,
    `status=${naHerstelRender.status} bytes=${(await naHerstelRender.arrayBuffer()).byteLength}`,
  );

  // ── 5. Grenzen ────────────────────────────────────────────────────────────
  const traag = '<html><body>' + '<div>vulling</div>'.repeat(20000) + '</body></html>';
  const gelijktijdig = await Promise.all([
    genereer({ body: { html: traag } }),
    genereer({ body: { html: traag } }),
    genereer({ body: { html: traag } }),
    genereer({ body: { html: traag } }),
  ]);
  const statussen = gelijktijdig.map((r) => r.status);
  await Promise.all(gelijktijdig.map((r) => r.arrayBuffer().catch(() => {})));
  meld(
    '5. Boven de gelijktijdigheidslimiet volgt 503, geen wachtrij',
    statussen.includes(503),
    `statussen bij 4 gelijktijdige requests (limiet 2): ${statussen.join(', ')}`,
  );

  const teGroot = await genereer({ body: { html: 'x'.repeat(6 * 1024 * 1024) } });
  meld('5b. Te grote body → 413', teGroot.status === 413, `status=${teGroot.status}`);

  const geenHtml = await genereer({ body: { bestandsnaam: 'leeg' } });
  meld('5c. Ontbrekende html → 400', geenHtml.status === 400, `status=${geenHtml.status}`);
}

main()
  .then(() => {
    const gefaald = resultaten.filter((r) => !r.gehaald);
    console.log(`\n${resultaten.length - gefaald.length}/${resultaten.length} checks gehaald\n`);
    process.exitCode = gefaald.length === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error(`\nAcceptatie afgebroken: ${error.stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server && !server.killed) server.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode ?? 1), 2000).unref();
  });
