const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// .dockerignore van vóór de fix (D-10/#2), om te bewijzen dat de test daarop rood is.
const OLD_DOCKERIGNORE = `.git
.gitignore
node_modules
npm-debug.log
.env
.env.*
!.env.example
test
scripts
README.md
`;

function parseCopySources(dockerfileContent) {
  const sources = [];
  for (const rawLine of dockerfileContent.split('\n')) {
    const line = rawLine.trim();
    if (!/^COPY\s/i.test(line)) continue;
    const parts = line.split(/\s+/).slice(1);
    // laatste woord is de bestemming; alles ervoor zijn bronnen (of vlaggen zoals --chown=...)
    const dest = parts.pop();
    for (const part of parts) {
      if (part.startsWith('--from=')) return null; // COPY --from meerdere fase: geen build-context bron
      if (part.startsWith('--')) continue;
      sources.push(part.replace(/^\.\//, ''));
    }
    void dest;
  }
  return sources;
}

function patternToRegex(pattern) {
  const segments = pattern.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  const regexStr = segments
    .map((seg) =>
      seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    )
    .join('/');
  return new RegExp(`^${regexStr}(/.*)?$`);
}

function isIgnored(filePath, dockerignoreContent) {
  let ignored = false;
  for (const rawLine of dockerignoreContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    if (patternToRegex(pattern).test(filePath)) {
      ignored = !negate;
    }
  }
  return ignored;
}

function findIgnoredCopySources(dockerfileContent, dockerignoreContent) {
  const sources = parseCopySources(dockerfileContent);
  return sources.filter((src) => isIgnored(src, dockerignoreContent));
}

test('oude .dockerignore sluit een COPY-bron uit de Dockerfile uit (rood, reproduceert Coolify-fout)', () => {
  const dockerfileContent = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const ignored = findIgnoredCopySources(dockerfileContent, OLD_DOCKERIGNORE);
  assert.deepEqual(ignored, ['scripts/install-tini.js']);
});

test('huidige .dockerignore sluit geen enkele COPY-bron uit de Dockerfile uit', () => {
  const dockerfileContent = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignoreContent = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const ignored = findIgnoredCopySources(dockerfileContent, dockerignoreContent);
  assert.deepEqual(ignored, []);
});
