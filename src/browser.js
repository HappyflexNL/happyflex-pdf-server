'use strict';

const puppeteer = require('puppeteer');

// Eén browser voor de hele service, niet één per request. Een pagina is goedkoop, een
// Chromium-start niet — en per request starten lekt geheugen zodra er iets misgaat.
//
// Toestanden: 'gestopt' → 'startend' → 'gereed' → ('herstartend' → 'startend' → …)
// De browser kan buiten ons om wegvallen (crash, OOM-kill). Daarom luisteren we op
// 'disconnected' en starten we zelf opnieuw, met oplopende backoff.

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // /dev/shm is in een container standaard 64 MB; Chromium loopt daar stuk op grote pagina's.
  '--disable-dev-shm-usage',
  // Bewust géén --disable-gpu: met die vlag vuurt `networkidle0` op deze Chrome niet meer,
  // waardoor élke render in de timeout loopt. Gemeten, niet aangenomen — zie het contract.
];

const BACKOFF_MS = [0, 500, 2_000, 5_000, 10_000];
const VERSION_PROBE_TIMEOUT_MS = 2_000;

class BrowserManager {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.browser = null;
    this.state = 'gestopt';
    this.lastError = null;
    this.restartCount = 0;
    this.shuttingDown = false;
    this._starting = null;
    this._restartTimer = null;
  }

  async start() {
    if (this.shuttingDown) throw new Error('service sluit af');
    if (this.state === 'gereed' && this.browser?.connected) return this.browser;
    if (this._starting) return this._starting;

    this.state = 'startend';
    this._starting = (async () => {
      const browser = await puppeteer.launch({ args: LAUNCH_ARGS });
      browser.once('disconnected', () => this._onDisconnected());
      this.browser = browser;
      this.state = 'gereed';
      this.lastError = null;
      this.logger.info?.(`browser gestart (pid ${browser.process()?.pid ?? 'onbekend'})`);
      return browser;
    })();

    try {
      return await this._starting;
    } catch (error) {
      this.state = 'gestopt';
      this.lastError = error.message;
      throw error;
    } finally {
      this._starting = null;
    }
  }

  _onDisconnected() {
    if (this.shuttingDown) return;
    this.browser = null;
    this.state = 'herstartend';
    this.restartCount += 1;
    const wachttijd = BACKOFF_MS[Math.min(this.restartCount - 1, BACKOFF_MS.length - 1)];
    this.logger.error?.(`browser weggevallen — herstart over ${wachttijd} ms (poging ${this.restartCount})`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.start().catch((error) => {
        this.lastError = error.message;
        this.logger.error?.(`herstart mislukt: ${error.message}`);
        // Nog niet gereed: /health blijft niet-200 en de volgende poging volgt via _onDisconnected
        // of via het eerstvolgende request dat start() aanroept.
      });
    }, wachttijd);
    this._restartTimer.unref?.();
  }

  /** De browser waarop gerenderd mag worden, of een fout als hij er niet is. */
  get() {
    if (this.state !== 'gereed' || !this.browser?.connected) {
      throw Object.assign(new Error('browser niet beschikbaar'), { code: 'BROWSER_UNAVAILABLE' });
    }
    return this.browser;
  }

  /**
   * Status voor /health. Doet een echte CDP-heenweg (browser.version()), want een
   * gezette vlag bewijst niet dat Chromium nog antwoordt.
   */
  async health() {
    const basis = {
      state: this.state,
      // puppeteer ≥ 23 heeft `connected` als getter; `isConnected()` bestaat niet meer.
      connected: Boolean(this.browser?.connected),
      pid: this.browser?.process()?.pid ?? null,
      restarts: this.restartCount,
      last_error: this.lastError,
    };

    if (this.state !== 'gereed' || !basis.connected) {
      return { ok: false, ...basis, version: null };
    }

    try {
      const version = await withTimeout(
        this.browser.version(),
        VERSION_PROBE_TIMEOUT_MS,
        'browser antwoordt niet binnen de probe-timeout',
      );
      return { ok: true, ...basis, version };
    } catch (error) {
      return { ok: false, ...basis, version: null, last_error: error.message };
    }
  }

  async stop() {
    this.shuttingDown = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const browser = this.browser;
    this.browser = null;
    this.state = 'gestopt';
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function withTimeout(promise, ms, boodschap) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    // Bewust niet ge-unref'd: dit is een deadline die moet afgaan, ook als er verder niets
    // meer op de event loop staat. De timer wordt opgeruimd zodra de race beslist is.
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(boodschap)), ms);
    }),
  ]);
}

module.exports = { BrowserManager, withTimeout, LAUNCH_ARGS };
