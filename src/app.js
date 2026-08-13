'use strict';

const crypto = require('node:crypto');
const express = require('express');

const { renderPdf, veiligeBestandsnaam } = require('./render');

const AUTH_HEADER = 'x-render-token';

/** Vergelijkt in constante tijd, ook als de lengtes verschillen. */
function tokenKlopt(aangeboden, verwacht) {
  if (typeof aangeboden !== 'string' || aangeboden.length === 0) return false;
  const a = crypto.createHash('sha256').update(aangeboden).digest();
  const b = crypto.createHash('sha256').update(verwacht).digest();
  return crypto.timingSafeEqual(a, b);
}

function fout(res, status, code, boodschap) {
  return res.status(status).json({ error: code, message: boodschap });
}

/**
 * Bouwt de express-app.
 *
 * Volgorde is hier inhoudelijk, niet cosmetisch:
 *   /health  → vóór auth, want de orchestrator heeft geen secret
 *   auth     → vóór express.json, zodat een request zonder geldig secret niet eens geparsed wordt
 */
function createApp({ config, browserManager, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  const stats = { inflight: 0, totaal: 0, mislukt: 0, geweigerd: 0, gestartOp: Date.now() };

  app.get('/health', async (_req, res) => {
    const browser = await browserManager.health();
    const body = {
      status: browser.ok ? 'ok' : 'degraded',
      browser,
      renders: {
        inflight: stats.inflight,
        max_concurrent: config.maxConcurrentRenders,
        totaal: stats.totaal,
        mislukt: stats.mislukt,
        geweigerd: stats.geweigerd,
      },
      uptime_s: Math.round((Date.now() - stats.gestartOp) / 1000),
    };
    res.status(browser.ok ? 200 : 503).json(body);
  });

  app.use((req, res, next) => {
    if (!tokenKlopt(req.get(AUTH_HEADER), config.token)) {
      logger.warn?.(`401 ${req.method} ${req.path} — geen of ongeldig token`);
      return fout(res, 401, 'unauthorized', 'Ongeldig of ontbrekend servicetoken.');
    }
    return next();
  });

  app.use(express.json({ limit: config.maxBodyBytes, type: 'application/json' }));

  app.post('/generate', async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);

    if (stats.inflight >= config.maxConcurrentRenders) {
      stats.geweigerd += 1;
      logger.warn?.(`503 ${requestId} — ${stats.inflight} renders bezig, limiet ${config.maxConcurrentRenders}`);
      res.setHeader('Retry-After', String(config.retryAfterSeconds));
      return fout(res, 503, 'overloaded', 'Renderservice zit aan zijn gelijktijdigheidslimiet.');
    }

    // `naam` is de legacy-veldnaam uit de n8n-workflows (CV Wizard). Die blijven werken;
    // `bestandsnaam` wint wanneer beide meekomen. Zonder deze alias zouden bestaande
    // aanroepers stil hun bestandsnaam verliezen: CV_<naam>.pdf zou document.pdf worden.
    const { html, bestandsnaam, naam: legacyNaam } = req.body ?? {};
    if (typeof html !== 'string' || html.trim() === '') {
      return fout(res, 400, 'invalid_request', 'Veld "html" is verplicht en moet een niet-lege string zijn.');
    }

    let browser;
    try {
      browser = browserManager.get();
    } catch {
      logger.error?.(`503 ${requestId} — browser niet beschikbaar`);
      res.setHeader('Retry-After', String(config.retryAfterSeconds));
      return fout(res, 503, 'browser_unavailable', 'Renderservice heeft op dit moment geen werkende browser.');
    }

    stats.inflight += 1;
    const start = Date.now();
    try {
      const pdf = await renderPdf(browser, html, { timeoutMs: config.renderTimeoutMs });
      const naam = veiligeBestandsnaam(bestandsnaam ?? legacyNaam);

      stats.totaal += 1;
      logger.info?.(`200 ${requestId} — ${pdf.length} bytes in ${Date.now() - start} ms`);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(pdf.length));
      res.setHeader('Content-Disposition', `attachment; filename="${naam}"; filename*=UTF-8''${encodeURIComponent(naam)}`);
      return res.status(200).end(pdf);
    } catch (error) {
      stats.mislukt += 1;
      const verlopen = /timeout|overschreed/i.test(error.message);
      // De melding gaat naar het log, niet naar de client: HTML-inhoud en interne paden
      // horen niet in een respons thuis.
      logger.error?.(`${verlopen ? 504 : 500} ${requestId} — ${error.message}`);
      return verlopen
        ? fout(res, 504, 'render_timeout', `Render duurde langer dan ${config.renderTimeoutMs} ms.`)
        : fout(res, 500, 'render_failed', 'Renderen van het document is mislukt.');
    } finally {
      stats.inflight -= 1;
    }
  });

  app.use((_req, res) => fout(res, 404, 'not_found', 'Onbekend eindpunt.'));

  // express.json geeft 413 bij een te grote body en 400 bij ongeldige JSON.
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return fout(res, 413, 'payload_too_large', `Body groter dan ${config.maxBodyBytes} bytes.`);
    }
    if (error?.type === 'entity.parse.failed') {
      return fout(res, 400, 'invalid_json', 'Body is geen geldige JSON.');
    }
    logger.error?.(`500 — onverwachte fout: ${error?.message}`);
    return fout(res, 500, 'internal_error', 'Onverwachte fout.');
  });

  return app;
}

module.exports = { createApp, veiligeBestandsnaam, AUTH_HEADER };
