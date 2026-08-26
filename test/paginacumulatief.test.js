'use strict';

// Pure unit-tests voor de chunk-berekening (D-10) — geen browser nodig. Het echte bewijs tegen
// een draaiende Chromium (drie pagina's, een wrappende regel) staat in `scripts/acceptance.mjs`,
// omdat alleen dáár de ECHTE printlayout gemeten kan worden — zie de toelichting in
// `src/paginacumulatief.js`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { berekenChunks } = require('../src/paginacumulatief');

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
