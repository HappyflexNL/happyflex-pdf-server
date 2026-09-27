'use strict';

// BrowserManager tegen een dubbel dat de échte puppeteer-Browser-vorm nabootst.
// Reden: puppeteer ≥ 23 heeft `connected` als getter en géén isConnected(). Die wissel
// brak de service eerder pas bij het eerste request — deze tests vangen dat af.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { BrowserManager } = require('../src/browser');

const STIL = { info() {}, warn() {}, error() {} };

/** Zelfde oppervlak als puppeteer 25: `connected` is een getter, isConnected() bestaat niet. */
function nepBrowser({ pid = 4242, version = 'Chrome/151.0.0.0' } = {}) {
  const browser = new EventEmitter();
  browser._connected = true;
  Object.defineProperty(browser, 'connected', { get: () => browser._connected });
  browser.version = async () => version;
  browser.process = () => ({ pid });
  browser.close = async () => {
    browser._connected = false;
  };
  browser.crash = () => {
    browser._connected = false;
    browser.emit('disconnected');
  };
  return browser;
}

test('health gebruikt de connected-getter en doet een echte version-probe', async () => {
  const manager = new BrowserManager({ logger: STIL });
  manager.browser = nepBrowser();
  manager.state = 'gereed';

  const health = await manager.health();
  assert.equal(health.ok, true);
  assert.equal(health.connected, true);
  assert.equal(health.version, 'Chrome/151.0.0.0');
  assert.equal(health.pid, 4242);
});

test('health is niet-ok zodra de browser losraakt', async () => {
  const manager = new BrowserManager({ logger: STIL });
  const browser = nepBrowser();
  manager.browser = browser;
  manager.state = 'gereed';

  browser._connected = false;
  const health = await manager.health();
  assert.equal(health.ok, false);
  assert.equal(health.connected, false);
});

test('health is niet-ok als de browser niet meer antwoordt', async () => {
  const manager = new BrowserManager({ logger: STIL });
  const browser = nepBrowser();
  browser.version = () => new Promise(() => {}); // antwoordt nooit
  manager.browser = browser;
  manager.state = 'gereed';

  const health = await manager.health();
  assert.equal(health.ok, false);
  assert.match(health.last_error, /probe-timeout/);
});

test('get() weigert zodra de browser weg is', () => {
  const manager = new BrowserManager({ logger: STIL });
  const browser = nepBrowser();
  manager.browser = browser;
  manager.state = 'gereed';

  assert.equal(manager.get(), browser);

  browser._connected = false;
  assert.throws(() => manager.get(), /browser niet beschikbaar/);
});

test('een crash zet de state op herstartend en telt de restart', async () => {
  const manager = new BrowserManager({ logger: STIL });
  const browser = nepBrowser();
  manager.browser = browser;
  manager.state = 'gereed';
  // koppel de manager-handler zoals start() dat doet
  browser.once('disconnected', () => manager._onDisconnected());
  browser.crash();

  assert.equal(manager.state, 'herstartend');
  assert.equal(manager.restartCount, 1);
  assert.throws(() => manager.get(), /browser niet beschikbaar/);

  const health = await manager.health();
  assert.equal(health.ok, false);
  assert.equal(health.state, 'herstartend');

  await manager.stop(); // ruimt de geplande herstart op
});

/** Wacht tot `conditie()` waar is, of geeft op na `timeoutMs`. */
function wachtTot(conditie, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const begin = Date.now();
    (function tick() {
      if (conditie()) return resolve();
      if (Date.now() - begin > timeoutMs) return reject(new Error('timeout bij wachten op voorwaarde'));
      setTimeout(tick, 5);
    })();
  });
}

// ── Zelfherstel: doorlopend, niet één poging ─────────────────────────────────
// De productie-incident was precies dit: één mislukte herstart en daarna niets meer, want
// niemand plande een volgende poging. Deze tests bewijzen dat dat nu niet meer kan.

test('(a) na een disconnect herstart de manager zelf en wordt weer gereed', async () => {
  let aantalLaunches = 0;
  const launch = async () => {
    aantalLaunches += 1;
    return nepBrowser({ pid: 5000 + aantalLaunches });
  };
  const manager = new BrowserManager({ logger: STIL, launch, backoffMs: [0] });

  const eersteBrowser = await manager.start();
  assert.equal(manager.state, 'gereed');
  assert.equal(aantalLaunches, 1);

  eersteBrowser.crash();
  assert.equal(manager.state, 'herstartend');

  await wachtTot(() => manager.state === 'gereed');
  assert.equal(aantalLaunches, 2);
  assert.equal(manager.restartCount, 1);
  assert.ok(manager.browser?.connected);

  await manager.stop();
});

test('(b) blijft proberen als de launch meerdere keren mislukt, en wordt daarna gereed', async () => {
  let poging = 0;
  const launch = async () => {
    poging += 1;
    if (poging <= 3) throw new Error(`kunstmatige launch-fout ${poging}`);
    return nepBrowser({ pid: 6000 + poging });
  };
  const manager = new BrowserManager({ logger: STIL, launch, backoffMs: [0] });

  // De eerste, expliciete start() faalt gewoon — de aanroeper mag dat weten.
  await assert.rejects(() => manager.start(), /kunstmatige launch-fout 1/);
  assert.equal(manager.state, 'herstartend');

  // Maar de manager blijft zelf doorproberen, óók al is er niemand meer die start() aanriep.
  await wachtTot(() => manager.state === 'gereed');
  assert.equal(poging, 4);
  assert.equal(manager.restartCount, 3);
  assert.equal(manager.lastError, null);

  await manager.stop();
});

test('(c) blijft de browser onafgebroken onbereikbaar, dan wordt het fatale pad aangeroepen', async () => {
  const launch = async () => {
    throw new Error('altijd mis');
  };
  let fataalAangeroepen = 0;
  const manager = new BrowserManager({
    logger: STIL,
    launch,
    backoffMs: [0],
    maxUnhealthyMs: 20,
    onFatal: () => {
      fataalAangeroepen += 1;
    },
  });

  await assert.rejects(() => manager.start(), /altijd mis/);
  await wachtTot(() => fataalAangeroepen > 0);

  // Eenmaal fataal gemeld, plant de manager geen nieuwe poging meer — anders zou hij, als
  // process.exit(1) in productie niet meteen ingrijpt, oneindig fatale meldingen blijven sturen.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fataalAangeroepen, 1);

  await manager.stop();
});

test('stop() maakt de manager stil — geen herstart meer na afsluiten', async () => {
  const manager = new BrowserManager({ logger: STIL });
  const browser = nepBrowser();
  manager.browser = browser;
  manager.state = 'gereed';
  browser.once('disconnected', () => manager._onDisconnected());

  await manager.stop();
  browser.crash();

  assert.equal(manager.state, 'gestopt');
  assert.equal(manager.restartCount, 0);
});
