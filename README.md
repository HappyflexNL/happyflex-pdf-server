# happyflex-pdf-server

Interne renderservice voor `happyflex-app`: **HTML erin, A4-PDF eruit.** Verder niets.

De service kent geen documenttypen, geen sjablonen en geen opslag. Wat er in de PDF staat
bepaalt de aanroeper; wat er met de bytes gebeurt ook.

## Waarom een aparte service

`happyflex-app` draait op `node:22-alpine` (musl libc), en daar bestaan geen officiële
Chromium-builds voor. Chromium in het app-image duwen zou een basisimage-wissel vragen en de
geheugenmarge op de buildnode opeten. Een OOM in een losse service sleurt de app niet mee; in
dezelfde container wel.

## Contract

### `POST /generate`

| | |
|---|---|
| Header | `X-Render-Token: <gedeeld secret>` — **verplicht** |
| Body | `{ "html": "<!doctype html>…", "bestandsnaam": "Jaaroverzicht 2026" }` |
| 200 | `application/pdf`, met `Content-Disposition: attachment; filename="Jaaroverzicht_2026.pdf"` |

`html` is verplicht en moet een niet-lege string zijn. `bestandsnaam` is optioneel; hij wordt
gesaneerd naar ASCII zonder padscheiders en krijgt altijd de extensie `.pdf`. Ontbreekt hij of
blijft er na sanering niets over, dan heet het bestand `document.pdf`.

| Status | Wanneer |
|---|---|
| `400` | `html` ontbreekt of is leeg · body is geen geldige JSON |
| `401` | token ontbreekt of klopt niet — **vóór** de body wordt geparsed |
| `413` | body groter dan `MAX_BODY_BYTES` |
| `503` | gelijktijdigheidslimiet bereikt, of geen werkende browser — met `Retry-After` |
| `504` | render duurde langer dan `RENDER_TIMEOUT_MS` |
| `500` | render mislukt om een andere reden |

Foutresponses zijn JSON (`{ "error": …, "message": … }`) en bevatten nooit de aangeleverde
HTML, een stacktrace of een intern pad. Elke render krijgt een `X-Request-Id` die ook in het
log staat.

### `GET /health`

Ongeauthenticeerd, want de orchestrator heeft geen secret. Geeft `200` alleen wanneer de
browser er is **en** antwoordt op een echte CDP-heenweg — niet wanneer alleen express nog
leeft. Zolang de browser weg is of herstart: `503`.

```json
{ "status": "ok",
  "browser": { "state": "gereed", "connected": true, "pid": 42, "version": "Chrome/151…", "restarts": 0 },
  "renders": { "inflight": 0, "max_concurrent": 2, "totaal": 17, "mislukt": 0, "geweigerd": 0 },
  "uptime_s": 3600 }
```

## Configuratie

Alles via env. Ontbreekt of deugt er iets niet, dan **start de service niet** — dat faalt bij
boot, niet bij het eerste request.

| Variabele | Default | Betekenis |
|---|---|---|
| `RENDER_SERVICE_TOKEN` | — | **Verplicht.** Gedeeld secret, minimaal 32 tekens |
| `PORT` | `3000` | |
| `MAX_BODY_BYTES` | `5242880` | Body-limiet (5 MB) |
| `RENDER_TIMEOUT_MS` | `20000` | Harde bovengrens per render |
| `MAX_CONCURRENT_RENDERS` | `2` | Daarboven direct `503`, geen wachtrij |
| `RETRY_AFTER_SECONDS` | `5` | Waarde van de `Retry-After`-header |
| `SHUTDOWN_GRACE_MS` | `15000` | Wachttijd op lopende renders bij `SIGTERM` |

Genereer het secret met `openssl rand -hex 32` en zet hem in Coolify-env — **nooit in deze
repo**.

## Hoe hij zich gedraagt

- **Eén browser voor de hele service**, niet één per request: een Chromium-start is duur en
  per-request starten lekt zodra er iets misgaat. Valt de browser weg (crash, OOM-kill), dan
  herstart de service hem zelf met oplopende backoff en meldt `/health` intussen `503`.
- **Eén browsercontext per render.** Cookies, localStorage en cache blijven binnen één
  request; twee documenten delen niets. Dat houdt het geheugen ook vlak — gemeten over 15
  renders: 498 → 480 MB (0,96×). Met alleen een pagina per render liep dat op tot 1670 MB.
- **`waitUntil: 'load'` plus een expliciete wachtslag** op `document.fonts.ready` en op nog
  ladende `<img>`. Bewust géén `networkidle0`: die vuurt op deze Chrome met enige regelmaat
  niet, waardoor renders willekeurig in de timeout liepen terwijl de pagina allang klaar was.
- **Géén `--disable-gpu`.** Met die vlag vuurde `networkidle0` helemaal niet meer. Gemeten,
  niet aangenomen.

## Beveiliging

- Het token wordt in constante tijd vergeleken en de auth-middleware staat **vóór** de
  bodyparser: een request zonder geldig secret wordt niet eens geparsed.
- De service hoort **alleen op het interne Coolify-netwerk**. Geen publieke route, geen
  domein.
- `/generate` rendert HTML die de aanroeper aanlevert, en Chromium haalt daarbij op wat die
  HTML noemt. Wie kan renderen kan dus vanaf deze service het interne netwerk benaderen. Dat
  is aanvaardbaar zolang beide bovenstaande punten gelden — vervalt er één, dan is dit een
  openstaand risico.

## Lokaal draaien

```bash
npm ci
export RENDER_SERVICE_TOKEN=$(openssl rand -hex 32)
npm start
```

Buiten het image heeft puppeteer een browser nodig: `npx puppeteer browsers install chrome`,
of wijs `PUPPETEER_EXECUTABLE_PATH` naar een Chrome op deze machine.

```bash
npm test                        # unit- en HTTP-tests, geen browser nodig
node scripts/acceptance.mjs     # volledige acceptatie tegen een echte browser (vereist pdftotext)
```

## Versies

Puppeteer én het basisimage staan op **exact 25.6.0**, zonder range. De browser is de
zwaarste afhankelijkheid hier; een stille minor-sprong is precies wat een renderservice
onvoorspelbaar maakt. De browser komt uit onze eigen gepinde puppeteer (`PUPPETEER_CACHE_DIR`
in `/app`), niet uit het basisimage — dat pad is een eigenschap van het image en geen
contract.

## Eigendom

Deze repo is de canonieke bron van de service; de draaiende Coolify-service is de stand.
`happyflex-app` beschrijft in `docs/domains/documenten/render-contract.md` hoe de app hem
aanroept — dat document beschrijft de koppeling, het vervangt deze repo niet.
