'use strict';

// Elke waarde komt uit env. Ontbreekt of deugt er iets niet, dan faalt de service bij boot —
// niet pas bij het eerste request.

const MIN_TOKEN_LENGTH = 32;

function readInt(env, naam, fallback, min, max) {
  const raw = env[naam];
  if (raw === undefined || raw === '') return fallback;
  const waarde = Number(raw);
  if (!Number.isInteger(waarde) || waarde < min || waarde > max) {
    throw new Error(`${naam} moet een geheel getal zijn tussen ${min} en ${max} (kreeg: ${raw})`);
  }
  return waarde;
}

function loadConfig(env = process.env) {
  const token = env.RENDER_SERVICE_TOKEN;
  if (!token) {
    throw new Error('RENDER_SERVICE_TOKEN ontbreekt — de service start niet zonder gedeeld secret');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`RENDER_SERVICE_TOKEN is te kort (${token.length} tekens, minimaal ${MIN_TOKEN_LENGTH})`);
  }

  return {
    token,
    port: readInt(env, 'PORT', 3000, 1, 65535),
    // Body-limiet in bytes. express.json geeft 413 zodra hij eroverheen gaat.
    maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 5 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    // Harde bovengrens per render. Loopt hij eroverheen, dan gaat de pagina dicht en volgt 504.
    renderTimeoutMs: readInt(env, 'RENDER_TIMEOUT_MS', 20_000, 1_000, 120_000),
    // Zoveel renders tegelijk. Daarboven direct 503 — niet in de wachtrij, niet stilstaan.
    maxConcurrentRenders: readInt(env, 'MAX_CONCURRENT_RENDERS', 2, 1, 32),
    // Wachttijd die we een overbelaste client meegeven (Retry-After, seconden).
    retryAfterSeconds: readInt(env, 'RETRY_AFTER_SECONDS', 5, 1, 300),
    // Hoelang we bij SIGTERM op lopende renders wachten voor we hard afsluiten.
    shutdownGraceMs: readInt(env, 'SHUTDOWN_GRACE_MS', 15_000, 0, 120_000),
  };
}

module.exports = { loadConfig, MIN_TOKEN_LENGTH };
