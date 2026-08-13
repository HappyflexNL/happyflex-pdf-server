'use strict';

const { loadConfig } = require('./src/config');
const { BrowserManager } = require('./src/browser');
const { createApp } = require('./src/app');

async function main() {
  // Deugt de env niet, dan stopt het hier — niet pas bij het eerste request.
  const config = loadConfig();

  const browserManager = new BrowserManager({ logger: console });
  await browserManager.start();

  const app = createApp({ config, browserManager, logger: console });
  const server = app.listen(config.port, () => {
    console.info(
      `renderservice luistert op poort ${config.port} ` +
        `(max ${config.maxConcurrentRenders} gelijktijdige renders, timeout ${config.renderTimeoutMs} ms)`,
    );
  });

  let afsluiten = false;
  for (const signaal of ['SIGTERM', 'SIGINT']) {
    process.on(signaal, () => {
      if (afsluiten) return;
      afsluiten = true;
      console.info(`${signaal} ontvangen — service sluit af`);

      const harde = setTimeout(() => {
        console.error('afsluiten duurde te lang — hard afbreken');
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
