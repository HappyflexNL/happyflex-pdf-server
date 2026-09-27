'use strict';

const { loadConfig } = require('./src/config');
const { BrowserManager } = require('./src/browser');
const { createApp } = require('./src/app');
const { createLogger } = require('./src/logger');

async function main() {
  const logger = createLogger(console);

  // Deugt de env niet, dan stopt het hier — niet pas bij het eerste request.
  const config = loadConfig();

  const browserManager = new BrowserManager({ logger, maxUnhealthyMs: config.browserMaxUnhealthyMs });

  // Bewust niet awaited: mislukt de eerste launch, dan mag de service toch starten. /health
  // meldt intussen 503 en BrowserManager blijft zelf met oplopende backoff proberen — zie
  // browser.js. Alleen bij aanhoudend falen (BROWSER_MAX_UNHEALTHY_MS) geeft de manager het
  // zelf op met process.exit(1).
  browserManager.start().catch((error) => {
    logger.error(`eerste browserstart mislukt, zelfherstel loopt door: ${error.message}`);
  });

  const app = createApp({ config, browserManager, logger });
  const server = app.listen(config.port, () => {
    logger.info(
      `renderservice luistert op poort ${config.port} ` +
        `(max ${config.maxConcurrentRenders} gelijktijdige renders, timeout ${config.renderTimeoutMs} ms)`,
    );
  });

  let afsluiten = false;
  for (const signaal of ['SIGTERM', 'SIGINT']) {
    process.on(signaal, () => {
      if (afsluiten) return;
      afsluiten = true;
      logger.info(`${signaal} ontvangen — service sluit af`);

      const harde = setTimeout(() => {
        logger.error('afsluiten duurde te lang — hard afbreken');
        process.exit(1);
      }, config.shutdownGraceMs);
      harde.unref();

      server.close(async () => {
        await browserManager.stop();
        clearTimeout(harde);
        process.exit(0);
      });
    });
  }
}

main().catch((error) => {
  console.error(`service kon niet starten: ${error.message}`);
  process.exit(1);
});
