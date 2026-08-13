'use strict';

const { withTimeout } = require('./browser');

const MAX_FILENAME_LENGTH = 120;
const FALLBACK_FILENAME = 'document';

/**
 * Maakt van vrije invoer een veilige ASCII-bestandsnaam.
 *
 * De service kent geen documenttypen: wat er in de naam staat bepaalt de aanroeper.
 * Padscheiders, control-tekens en aanhalingstekens gaan eruit — die zouden in
 * Content-Disposition een header-injectie of een pad opleveren.
 */
function veiligeBestandsnaam(invoer) {
  const ruw = typeof invoer === 'string' ? invoer : '';
  const zonderAccenten = ruw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  let naam = zonderAccenten
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '') // alles buiten deze set verdwijnt, inclusief / \ " CR LF
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '') // geen verborgen bestand, geen naam die als flag leest
    .replace(/[._-]+$/, '')
    .slice(0, MAX_FILENAME_LENGTH);

  if (!naam) naam = FALLBACK_FILENAME;
  return `${naam}.pdf`;
}

/**
 * Rendert HTML naar een A4-PDF op een bestaande browser.
 *
 * De pagina gaat altijd dicht, ook bij een timeout: een blijvend openstaande pagina houdt
 * geheugen vast, en dat is precies wat een gedeelde browser duur maakt.
 */
async function renderPdf(browser, html, { timeoutMs }) {
  // Eigen browsercontext per render, niet alleen een eigen pagina: cookies, localStorage en
  // cache blijven zo binnen één request. Twee documenten van twee opdrachtgevers delen niets.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    return await withTimeout(
      (async () => {
        // Bewust 'load' en niet 'networkidle0'. Networkidle wacht op 500 ms netwerkstilte en
        // vuurt op deze Chrome met enige regelmaat helemaal niet — gemeten: renders die
        // willekeurig in de 20s-timeout liepen terwijl de pagina allang klaar was.
        // 'load' is deterministisch; wat we daarna écht nodig hebben, wachten we expliciet af.
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        await page.evaluate(() => {
          const afbeeldingen = Array.from(document.images)
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((klaar) => {
                  img.addEventListener('load', klaar, { once: true });
                  img.addEventListener('error', klaar, { once: true });
                }),
            );
          // Lettertypen tellen mee: zonder deze wachtslag rendert de PDF in een fallbackfont.
          return Promise.all([document.fonts.ready, ...afbeeldingen]);
        });
        return page.pdf({ format: 'A4', printBackground: true, timeout: timeoutMs });
      })(),
      timeoutMs,
      'render overschreed de timeout',
    );
  } finally {
    // De context sluiten ruimt de pagina en het bijbehorende rendererproces op, ook wanneer
    // de render in de timeout liep.
    await context.close().catch(() => {});
  }
}

module.exports = { renderPdf, veiligeBestandsnaam, MAX_FILENAME_LENGTH };
