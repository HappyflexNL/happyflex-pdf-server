'use strict';

// Echte Chromium: factuurvormen (12 regels, 18+ regels, 2-regelige betaalzin) en steekproeven van
// de andere pdf-soorten. De pdf-server kent geen documenttypen; deze tests bewijzen dat de
// D-10-correctie (herhalende SNA-voet van het paginaraster) niets breekt en 202600036 op één
// pagina houdt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const puppeteer = require('puppeteer');

const { renderPdf } = require('../src/render');
const { pasPaginaCumulatiefToe } = require('../src/paginacumulatief');

const CSS = `@page{size:A4;margin:20mm}body{margin:0;font:9pt Arial}
table{width:100%;border-collapse:collapse}td,th{padding:2mm 0}
table.factuur-paginaraster>thead{display:table-header-group}
table.factuur-paginaraster>tfoot{display:table-footer-group}
.kop{height:15mm}.sna{height:18mm;font-size:7pt}.titel{height:45mm}`;

function factuurHtml(regels, betaalzin = 'Betaling binnen 14 dagen.') {
  const rijen = Array.from(
    { length: regels },
    (_, i) => `<tr data-hf-aantal="8"><td>8</td><td>uur</td><td>Dienst dag ${i + 1}</td></tr>`,
  ).join('');
  return `<!doctype html><html><head><style>${CSS}</style></head><body>
<table class="factuur-paginaraster"><thead><tr><td class="kop">logo</td></tr></thead>
<tfoot><tr><td class="sna">NEN 4400 / SNA-voet</td></tr></tfoot><tbody><tr><td>
<div class="titel">Factuur 202600036</div>
<table data-hf-paginacumulatief><thead><tr><th>Aantal</th><th>Eenheid</th><th>Omschrijving</th></tr></thead>
<tbody>${rijen}</tbody>
<tfoot><tr data-hf-cumulatief-kolom="0" data-hf-label-kolom="2" data-hf-label="Over te brengen"><td>0</td><td>uren</td><td></td></tr></tfoot></table>
<p>${betaalzin}</p>
</td></tr></tbody></table></body></html>`;
}

const simpel = (titel, extra = '') =>
  `<!doctype html><html><head><style>@page{size:A4;margin:20mm}body{font:10pt Arial}</style></head><body><h1>${titel}</h1><p>Voorbeeldtekst.</p>${extra}</body></html>`;

async function start(t) {
  try {
    return await puppeteer.launch({ args: ['--no-sandbox'] });
  } catch {
    t.skip('geen Chromium beschikbaar');
    return null;
  }
}

async function paginas(browser, html) {
  const pdf = await renderPdf(browser, html, { timeoutMs: 20_000 });
  return (await PDFDocument.load(pdf)).getPageCount();
}

test('factuur met 12 regels → 1 pagina', async (t) => {
  const browser = await start(t);
  if (!browser) return;
  try {
    assert.equal(await paginas(browser, factuurHtml(12)), 1);
  } finally {
    await browser.close();
  }
});

test('factuur 202600036 met 2-regelige betaalzin → 1 pagina', async (t) => {
  const browser = await start(t);
  if (!browser) return;
  try {
    const zin =
      'Wij verzoeken u het totaalbedrag binnen 14 dagen na factuurdatum te voldoen op rekeningnummer NL00 TEST 0000 0000 00 ' +
      'onder vermelding van het factuurnummer 202600036, waarbij de algemene voorwaarden van toepassing zijn.';
    assert.equal(await paginas(browser, factuurHtml(12, zin)), 1);
  } finally {
    await browser.close();
  }
});

for (const regels of [18, 25, 40]) {
  test(`factuur met ${regels} regels → juiste "Over te brengen" per pagina, pagina's kloppen`, async (t) => {
    const browser = await start(t);
    if (!browser) return;
    try {
      const page = await browser.newPage();
      await page.setContent(factuurHtml(regels), { waitUntil: 'load' });
      const { verwachtAantalPaginas, naTabelInhoud } = await pasPaginaCumulatiefToe(page);
      assert.equal(naTabelInhoud, true); // de betaalzin staat ná de tabel
      const chunks = await page.evaluate(() =>
        [...document.querySelectorAll('table.hf-chunk')].map((t) => ({
          rijen: t.querySelectorAll('tbody > tr').length,
          cum: t.querySelector('tfoot tr td').textContent,
          label: t.querySelector('tfoot tr').children[2].textContent,
        })),
      );
      let lopend = 0;
      chunks.forEach((c, i) => {
        lopend += c.rijen * 8;
        assert.equal(c.cum, String(lopend), `chunk ${i + 1}: cumulatief`);
        assert.equal(c.label, i === chunks.length - 1 ? '' : 'Over te brengen');
      });
      assert.equal(lopend, regels * 8);
      assert.equal(chunks.length, verwachtAantalPaginas);
    } finally {
      await browser.close();
    }
  });
}

test('factuur met 18+ regels rendert zonder D-10-fout (render.js, paginacontrole)', async (t) => {
  const browser = await start(t);
  if (!browser) return;
  try {
    // renderPdf gooit bij een onverwacht aantal pagina's (D-10-controle); hier: geen gooi.
    for (const regels of [18, 25]) {
      assert.ok((await paginas(browser, factuurHtml(regels, ''))) >= 1, `${regels} regels`);
    }
    assert.ok((await paginas(browser, factuurHtml(40, ''))) >= 2);
  } finally {
    await browser.close();
  }
});

// Steekproef van de andere pdf-soorten: zonder D-10-marker byte-identiek pad, 1 pagina.
for (const soort of ['Zelffactuur', 'Contract', 'Opdrachtbevestiging', 'CV']) {
  test(`${soort} (zonder D-10-marker) → 1 pagina`, async (t) => {
    const browser = await start(t);
    if (!browser) return;
    try {
      assert.equal(await paginas(browser, simpel(soort)), 1);
    } finally {
      await browser.close();
    }
  });
}
