'use strict';

// Pure unit-tests voor de chunk-berekening (D-10) — geen browser nodig. Het echte bewijs tegen
// een draaiende Chromium (drie pagina's, een wrappende regel) staat in `scripts/acceptance.mjs`,
// omdat alleen dáár de ECHTE printlayout gemeten kan worden — zie de toelichting in
// `src/paginacumulatief.js`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { berekenChunks, verifieerPaginaAantal } = require('../src/paginacumulatief');

function rij(hoogte, aantal = 1) {
  return { hoogte, aantal };
}

function basisMeting(overrides = {}) {
  return {
    theadHoogte: 20,
    buitenTheadHoogte: 0,
    tfootHoogte: 20,
    eenmaligeKopHoogte: 0,
    rijen: [],
    ...overrides,
  };
}

test('berekenChunks: alle rijen passen op één pagina → één chunk met het volledige totaal', () => {
  const meting = basisMeting({ rijen: [rij(30), rij(30), rij(30)] });
  const chunks = berekenChunks(meting);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].aantalRijen, 3);
  assert.equal(chunks[0].cumulatiefTotaal, 3);
  assert.equal(chunks[0].isLaatste, true);
});

test('berekenChunks: cumulatief loopt op, niet per pagina opnieuw bij nul', () => {
  // Bruikbare hoogte kunstmatig klein maken zodat elke rij zijn eigen pagina krijgt.
  const meting = basisMeting({
    eenmaligeKopHoogte: 0,
    rijen: [rij(500, 5), rij(500, 7), rij(500, 3)],
  });
  const chunks = berekenChunks(meting);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].cumulatiefTotaal, 5);
  assert.equal(chunks[1].cumulatiefTotaal, 12);
  assert.equal(chunks[2].cumulatiefTotaal, 15);
  assert.equal(chunks[chunks.length - 1].isLaatste, true);
  assert.ok(chunks.slice(0, -1).every((c) => c.isLaatste === false));
});

test('berekenChunks: pagina 1 heeft minder capaciteit dan een vervolgpagina (eenmalige kop)', () => {
  // Twee scenario's met identieke rijen, alleen het verschil is de eenmalige kopruimte.
  const rijen = Array.from({ length: 10 }, () => rij(90, 1));
  const zonderEenmalig = berekenChunks(basisMeting({ rijen }));
  const metEenmalig = berekenChunks(basisMeting({ rijen, eenmaligeKopHoogte: 400 }));
  assert.ok(
    metEenmalig[0].aantalRijen <= zonderEenmalig[0].aantalRijen,
    'een eenmalige kop mag pagina 1 nooit MEER laten dragen dan zonder',
  );
});

test('berekenChunks: een regel die op zichzelf al niet in een lege pagina past → harde fout', () => {
  const meting = basisMeting({ rijen: [rij(1_000_000)] });
  assert.throws(() => berekenChunks(meting), /past op zichzelf al niet/);
});

test('berekenChunks: niet-positieve capaciteit (kopinhoud groter dan de pagina) → harde fout', () => {
  const meting = basisMeting({ eenmaligeKopHoogte: 999_999, rijen: [rij(10)] });
  assert.throws(() => berekenChunks(meting), /niet-positief/);
});

test('berekenChunks: lege rijenlijst levert geen chunks (geen NaN, geen crash)', () => {
  const chunks = berekenChunks(basisMeting({ rijen: [] }));
  assert.deepEqual(chunks, []);
});

test('verifieerPaginaAantal: zonder inhoud na de tabel is elk verschil een harde fout', () => {
  assert.doesNotThrow(() => verifieerPaginaAantal(2, 2));
  assert.throws(() => verifieerPaginaAantal(3, 2), /D-10-verificatie/);
  assert.throws(() => verifieerPaginaAantal(1, 2), /D-10-verificatie/);
});

test('verifieerPaginaAantal: inhoud na de tabel (totalen/betaalgegevens) mag extra pagina\'s geven, minder blijft fout', () => {
  // Spoedfactuur: 12 regels = 1 chunk, maar het blok na de tabel liep door naar pagina 2.
  assert.doesNotThrow(() => verifieerPaginaAantal(2, 1, { naTabelInhoud: true }));
  assert.throws(() => verifieerPaginaAantal(1, 2, { naTabelInhoud: true }), /D-10-verificatie/);
});

// Echte Chromium: factuurvorm met een tabel van 12 regels en veel inhoud erná. Vóór de correctie
// gaf dit D-10-verificatie "verwachtte 1 pagina, kreeg 2" → HTTP 500 render_failed.
test('renderPdf: 12 regels met lang slotblok na de tabel geeft een PDF (geen 500)', async (t) => {
  const puppeteer = require('puppeteer');
  const { renderPdf } = require('../src/render');
  let browser;
  try {
    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  } catch {
    return t.skip('geen Chromium beschikbaar');
  }
  try {
    const rijen = Array.from(
      { length: 12 },
      (_, i) => `<tr data-hf-aantal="8"><td>8</td><td>uur</td><td>Testpersoon week ${i + 1} Testschool</td></tr>`,
    ).join('');
    const slot = Array.from({ length: 25 }, (_, i) => `<p style="margin:0;height:10mm">Totaalregel ${i}</p>`).join('');
    const html = `<!doctype html><html><head><style>@page{size:A4;margin:20mm}body{margin:0;font:9pt Arial}table.regeltabel{width:100%;border-collapse:collapse}</style></head><body>
<table class="regeltabel" data-hf-paginacumulatief><thead><tr><th>Aantal</th><th>Eenheid</th><th>Omschrijving</th></tr></thead><tbody>${rijen}</tbody>
<tfoot><tr data-hf-cumulatief-kolom="0" data-hf-label-kolom="2" data-hf-label="Over te brengen"><td>0</td><td>uren</td><td></td></tr></tfoot></table>${slot}</body></html>`;
    const pdf = await renderPdf(browser, html, { timeoutMs: 20000 });
    assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
  } finally {
    await browser.close();
  }
});
