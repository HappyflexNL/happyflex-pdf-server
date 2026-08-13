'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { veiligeBestandsnaam } = require('../src/render');

const GELDIG_TOKEN = 'x'.repeat(32);

test('config: zonder token start de service niet', () => {
  assert.throws(() => loadConfig({}), /RENDER_SERVICE_TOKEN ontbreekt/);
});

test('config: een te kort token wordt geweigerd', () => {
  assert.throws(() => loadConfig({ RENDER_SERVICE_TOKEN: 'kort' }), /te kort/);
});

test('config: defaults staan vast', () => {
  const config = loadConfig({ RENDER_SERVICE_TOKEN: GELDIG_TOKEN });
  assert.equal(config.port, 3000);
  assert.equal(config.maxConcurrentRenders, 2);
  assert.equal(config.renderTimeoutMs, 20_000);
  assert.equal(config.maxBodyBytes, 5 * 1024 * 1024);
});

test('config: onzinnige numerieke env faalt bij boot, niet bij het eerste request', () => {
  assert.throws(
    () => loadConfig({ RENDER_SERVICE_TOKEN: GELDIG_TOKEN, MAX_CONCURRENT_RENDERS: '0' }),
    /MAX_CONCURRENT_RENDERS/,
  );
  assert.throws(
    () => loadConfig({ RENDER_SERVICE_TOKEN: GELDIG_TOKEN, RENDER_TIMEOUT_MS: 'straks' }),
    /RENDER_TIMEOUT_MS/,
  );
});

test('bestandsnaam: gewone invoer houdt zijn vorm', () => {
  assert.equal(veiligeBestandsnaam('Jaaroverzicht 2026'), 'Jaaroverzicht_2026.pdf');
  assert.equal(veiligeBestandsnaam('rapport.pdf'), 'rapport.pdf');
});

test('bestandsnaam: padscheiders en traversal overleven het niet', () => {
  assert.equal(veiligeBestandsnaam('../../etc/passwd'), 'etcpasswd.pdf');
  assert.equal(veiligeBestandsnaam('map/submap/naam'), 'mapsubmapnaam.pdf');
  assert.equal(veiligeBestandsnaam('C:\\Windows\\naam'), 'CWindowsnaam.pdf');
});

test('bestandsnaam: header-injectie is niet mogelijk', () => {
  const naam = veiligeBestandsnaam('a"\r\nX-Injected: 1');
  assert.equal(naam, 'aX-Injected_1.pdf');
  assert.ok(!/["\r\n]/.test(naam));
});

test('bestandsnaam: accenten worden ASCII, lege invoer krijgt een fallback', () => {
  assert.equal(veiligeBestandsnaam('Café Überzicht'), 'Cafe_Uberzicht.pdf');
  assert.equal(veiligeBestandsnaam(''), 'document.pdf');
  assert.equal(veiligeBestandsnaam(undefined), 'document.pdf');
  assert.equal(veiligeBestandsnaam('....'), 'document.pdf');
  assert.equal(veiligeBestandsnaam({ kwaad: true }), 'document.pdf');
});

test('bestandsnaam: lengte blijft begrensd', () => {
  const naam = veiligeBestandsnaam('a'.repeat(500));
  assert.equal(naam.length, 120 + '.pdf'.length);
});
