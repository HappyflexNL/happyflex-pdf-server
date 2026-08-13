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
