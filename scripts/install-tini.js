'use strict';

// Downloadt en verifieert tini (init-proces voor PID 1) tijdens de Docker-build. Draait nooit
// in productie — alleen als build-stap. Node zelf reapt geen zombies en de basisimage levert
// geen init: zonder tini als PID 1 stapelen weesprocessen van Chrome op na een mislukte start,
// tot er geen nieuwe meer kan starten ("Timed out ... WS endpoint").
//
// Bewust geen extra pakket (apt/curl) nodig: Node zelf is altijd aanwezig in dit basisimage.

const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TINI_VERSION = 'v0.19.0';
// sha256 opgehaald van de officiële release-assets van krallin/tini.
const CHECKSUMS = {
  amd64: 'c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee',
  arm64: 'eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9',
};
const DEST = '/usr/local/bin/tini';

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'happyflex-pdf-server-build' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(get(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download mislukt: HTTP ${res.statusCode} voor ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  const arch = process.env.TARGETARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const verwacht = CHECKSUMS[arch];
  if (!verwacht) {
    throw new Error(`onbekende architectuur voor tini: ${arch}`);
  }

  const url = `https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-${arch}`;
  const buffer = await get(url);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (hash !== verwacht) {
    throw new Error(`sha256 van tini komt niet overeen (verwacht ${verwacht}, kreeg ${hash})`);
  }

  fs.writeFileSync(DEST, buffer, { mode: 0o755 });
  console.log(`tini ${TINI_VERSION} (${arch}) geïnstalleerd naar ${DEST}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
