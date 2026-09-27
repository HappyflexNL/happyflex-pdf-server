'use strict';

const puppeteer = require('puppeteer');

// Eén browser voor de hele service, niet één per request. Een pagina is goedkoop, een
// Chromium-start niet — en per request starten lekt geheugen zodra er iets misgaat.
//
// Toestanden: 'gestopt' → 'startend' → 'gereed' → ('herstartend' → 'startend' → …)
// De browser kan buiten ons om wegvallen (crash, OOM-kill) of een herstart kan zelf mislukken
// (bijv. "Timed out ... WS endpoint"). In beide gevallen blijven we het proberen, met oplopende
// backoff — nooit stilvallen na één mislukte poging. Blijft de browser onafgebroken
// niet-gereed langer dan `maxUnhealthyMs`, dan is er geen redden meer aan binnen dit proces:
// we loggen dat duidelijk en roepen `onFatal` aan (standaard `process.exit(1)`), zodat de
// restart-policy van de container het overneemt — Docker/Coolify herstart een
// "unhealthy"-container namelijk niet uit zichzelf, alleen een gestopt proces.

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // /dev/shm is in een container standaard 64 MB; Chromium loopt daar stuk op grote pagina's.
  '--disable-dev-shm-usage',
  // Bewust géén --disable-gpu: met die vlag vuurt `networkidle0` op deze Chrome niet meer,
  // waardoor élke render in de timeout loopt. Gemeten, niet aangenomen — zie het contract.
];

// Oplopend tot 60 s, en daarna elke 60 s door — geen minuten wachten bij de eerste hik, maar
// ook niet vlammend blijven herproberen tegen een structureel probleem.
const BACKOFF_MS = [0, 500, 2_000, 5_000, 10_000, 30_000, 60_000];
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_UNHEALTHY_MS = 3 * 60 * 1000;

class BrowserManager {
  constructor({
    logger = console,
    maxUnhealthyMs = DEFAULT_MAX_UNHEALTHY_MS,
    onFatal,
    launch,
    backoffMs = BACKOFF_MS,
  } = {}) {
    this.logger = logger;
    this.maxUnhealthyMs = maxUnhealthyMs;
    this._backoffMs = backoffMs;
    // Injecteerbaar zodat tests een nepbrowser en mislukte pogingen kunnen simuleren zonder
    // een echte Chromium te starten.
    this._launch = launch ?? ((args) => puppeteer.launch(args));
    // Injecteerbaar zodat tests het laatste redmiddel kunnen aantonen zonder het testproces
    // te doden.
    this._onFatal = onFatal ?? (() => process.exit(1));
    this.browser = null;
    this.state = 'gestopt';
    this.lastError = null;
    this.restartCount = 0;
    this.shuttingDown = false;
    this._starting = null;
    this._retryTimer = null;
    this._consecutiveFailures = 0;
    // Tijdstip sinds wanneer we onafgebroken niet-gereed zijn; null zolang we gereed zijn.
    this._unhealthySince = null;
    // Proces van de laatst gestarte browser, voor opruiming vóór een nieuwe poging.
    this._lastProcess = null;
  }

  /**
   * Start de browser, of geeft de lopende poging terug. Wordt zowel bij boot als vanuit een
   * inkomend request aangeroepen: staat er een backoff-wachttijd te lopen, dan wordt die
   * overgeslagen — wie nu een browser nodig heeft, hoeft niet op de klok te wachten.
   */
  async start() {
    if (this.shuttingDown) throw new Error('service sluit af');
    if (this.state === 'gereed' && this.browser?.connected) return this.browser;
    if (this._starting) return this._starting;

    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }

    return this._attempt();
  }

  async _attempt() {
    this.state = 'startend';
    this._starting = (async () => {
      await this._ruimVerweesProcesOp();
      const browser = await this._launch({ args: LAUNCH_ARGS });
      browser.once('disconnected', () => this._onDisconnected());
      this.browser = browser;
      this._lastProcess = browser.process() ?? null;
      this.state = 'gereed';
      this.lastError = null;
      this._unhealthySince = null;
      this._consecutiveFailures = 0;
      this.logger.info?.(`browser gestart (pid ${this._lastProcess?.pid ?? 'onbekend'})`);
      return browser;
    })();

    try {
      return await this._starting;
    } catch (error) {
      this._verwerkMislukking(error);
      throw error;
    } finally {
      this._starting = null;
    }
  }

  /** Doodt een eventueel achtergebleven browserproces van de vorige (mislukte) poging. */
  async _ruimVerweesProcesOp() {
    const proces = this._lastProcess;
    this._lastProcess = null;
    if (!proces || proces.pid == null || proces.killed) return;
    try {
      process.kill(proces.pid, 0); // bestaat het nog?
    } catch {
      return; // al weg
    }
    this.logger.warn?.(`ruim verweesd browserproces op (pid ${proces.pid})`);
    try {
      proces.kill('SIGKILL');
    } catch (error) {
      this.logger.error?.(`kon verweesd browserproces niet opruimen: ${error.message}`);
    }
  }

  _onDisconnected() {
    if (this.shuttingDown) return;
    this.browser = null;
    this._gaHerstartend('browser weggevallen');
  }

  _verwerkMislukking(error) {
    this.browser = null;
    this.lastError = error.message;
    this._gaHerstartend(`herstart mislukt: ${error.message}`);
  }

  /** Gedeeld pad voor "we zijn niet meer gereed en moeten het opnieuw proberen". */
  _gaHerstartend(melding) {
    this.state = 'herstartend';
    this.restartCount += 1;
    this._consecutiveFailures += 1;
    if (!this._unhealthySince) this._unhealthySince = Date.now();

    const onafgebrokenMs = Date.now() - this._unhealthySince;
    if (onafgebrokenMs >= this.maxUnhealthyMs) {
      this.logger.error?.(
        `browser al ${Math.round(onafgebrokenMs / 1000)}s onafgebroken niet-gereed ` +
          `(grens ${Math.round(this.maxUnhealthyMs / 1000)}s) — service stopt zodat de ` +
          'restart-policy van de container overneemt',
      );
      this._onFatal();
      return;
    }

    const wachttijd = this._backoffMs[Math.min(this._consecutiveFailures - 1, this._backoffMs.length - 1)];
    this.logger.error?.(`${melding} — herstart over ${wachttijd} ms (poging ${this.restartCount})`);
    this._planHerstart(wachttijd);
  }

  _planHerstart(wachttijd) {
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      // _attempt() plant via _verwerkMislukking() zelf de volgende poging bij een nieuwe fout.
      this._attempt().catch(() => {});
    }, wachttijd);
    this._retryTimer.unref?.();
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
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    const browser = this.browser;
    this.browser = null;
    this.state = 'gestopt';
    this._lastProcess = null;
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

module.exports = { BrowserManager, withTimeout, LAUNCH_ARGS, BACKOFF_MS };
