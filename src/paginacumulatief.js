'use strict';

// ── D-10 — per-pagina cumulatieve hoeveelheidsregel ──────────────────────────────────────────
//
// Een `<tfoot>` herhaalt bij een paginabreuk met DEZELFDE statische inhoud op elke pagina (zelfde
// mechanisme als een herhalende `<thead>`, `display: table-footer-group`). Voor de afsluitende
// hoeveelheidsregel van een factuur/zelffactuur ("163 uren") is dat de D-10-fout: pagina 1 toont
// het eindtotaal, ook al bevat die pagina zelf maar een deel van de regels.
//
// Dit is GEEN architecturale toevoeging aan de renderpijplijn — we renderen al via Puppeteers
// `page.pdf()` (CDP `Page.printToPDF`); dit voegt daar één extra stap aan toe, vóór die ene
// printaanroep:
//   1. render de HTML zoals altijd (al gebeurd door de aanroeper);
//   2. meet, in datzelfde venster, per `<tr>` op welke "pagina" hij zou landen — afgeleid uit zijn
//      positie en de bruikbare paginahoogte;
//   3. bereken per pagina het cumulatieve aantal tot en met die pagina;
//   4. herbouw de tabel als N los geforceerde paginabreuken, elk met zijn EIGEN `<tfoot>`-waarde;
//   5. print (ongewijzigd, dezelfde `page.pdf()`-aanroep als altijd).
//
// Opt-in en documentsoort-neutraal: een tabel doet hier alleen aan mee met
// `data-hf-paginacumulatief`, gezet door de aanroeper (happyflex-app, `blokken/regeltabel.ts`).
// Geen marker → geen enkele wijziging, byte-identiek aan vóór D-10.
//
// GEOMETRIE-AANNAME (moet in sync blijven met happyflex-app's `sjablonen/print-frame.ts`):
// `@page { size: A4; margin: 20mm; }`. Er bestaat geen manier om een `@page`-regel via JS in de
// pagina te introspecteren, dus deze twee getallen staan hier letterlijk. Empirisch geverifieerd
// (26-08-2026, drie fixtures/40/65/wrap-regels): `page.pdf({ format: 'A4' })` zonder een eigen
// `margin`-optie respecteert deze CSS-marge exact.
const A4_HOOGTE_MM = 297;
const A4_BREEDTE_MM = 210;
const PAGINA_MARGE_MM = 20;
const PX_PER_MM = 96 / 25.4;
const BRUIKBARE_HOOGTE_PX = (A4_HOOGTE_MM - 2 * PAGINA_MARGE_MM) * PX_PER_MM;
const BRUIKBARE_BREEDTE_PX = Math.round((A4_BREEDTE_MM - 2 * PAGINA_MARGE_MM) * PX_PER_MM);
// Ruim genoeg dat geen enkel reëel document een verticale scrollbar krijgt tijdens het meten —
// die zou van de content-BREEDTE afsnoepen en precies de fout hieronder reproduceren.
const METING_VIEWPORT_HOOGTE_PX = 20_000;

/** Rondt op 2 decimalen en levert de tekstvorm zoals `afsluitendeHoeveelheid` in happyflex-app
 *  dat doet (`String(Math.round(x * 100) / 100)`) — geen aparte formatteerregel. */
function formatteerAantal(x) {
  return String(Math.round(x * 100) / 100);
}

/** True zodra er iets te doen valt — geen marker, geen enkele DOM-aanraking. */
async function heeftPaginacumulatieveTabel(page) {
  return page.evaluate(() => document.querySelector('[data-hf-paginacumulatief]') !== null);
}

/**
 * Meet, voor elke gemarkeerde tabel, alles wat nodig is om te bepalen welke rij op welke pagina
 * landt: de hoogte van wat er per pagina herhaalt (een omhullende paginaraster-`<thead>`, indien
 * aanwezig, plus de tabel-eigen `<thead>` en `<tfoot>`), de eenmalige koptekst die alleen op de
 * eerste pagina meetelt (alles tussen die twee koppen — afzender/titel/gegevensblok e.d.), en per
 * rij zijn hoogte plus zijn `data-hf-aantal`-bijdrage.
 */
async function meetTabellen(page) {
  return page.evaluate(() => {
    const tabellen = [...document.querySelectorAll('table[data-hf-paginacumulatief]')];
    return tabellen.map((tabel) => {
      const thead = tabel.querySelector(':scope > thead');
      const tfootRij = tabel.querySelector(':scope > tfoot > tr');
      const paginaraster = tabel.closest('table.factuur-paginaraster');
      const buitenThead = paginaraster ? paginaraster.querySelector(':scope > thead') : null;

      const theadRect = thead.getBoundingClientRect();
      const buitenRect = buitenThead ? buitenThead.getBoundingClientRect() : null;
      const tfootRect = tfootRij.getBoundingClientRect();

      const rijen = [...tabel.querySelectorAll(':scope > tbody > tr')].map((tr) => ({
        hoogte: tr.getBoundingClientRect().height,
        aantal: Number(tr.getAttribute('data-hf-aantal')),
      }));

      return {
        theadHoogte: theadRect.height,
        buitenTheadHoogte: buitenRect ? buitenRect.height : 0,
        tfootHoogte: tfootRect.height,
        // Alles tussen het eind van de buitenste (herhalende) kop en het begin van de tabel-eigen
        // kop — bestaat alleen op pagina 1 (afzender/ontvanger/titel/gegevensblok e.d.).
        eenmaligeKopHoogte: buitenRect ? theadRect.top - buitenRect.bottom : 0,
        cumulatiefKolom: Number(tfootRij.getAttribute('data-hf-cumulatief-kolom')),
        labelKolom: Number(tfootRij.getAttribute('data-hf-label-kolom')),
        labelTekst: tfootRij.getAttribute('data-hf-label') ?? '',
        rijen,
      };
    });
  });
}

/**
 * Groepeert rijen in pagina-chunks (greedy: vul een pagina tot de volgende rij niet meer past),
 * en berekent per chunk het cumulatieve `aantal` tot en met die chunk. Pagina 1 heeft minder
 * capaciteit dan een vervolgpagina, omdat alleen pagina 1 de eenmalige kopinhoud draagt.
 *
 * @throws als een ENKELE rij zelf al niet binnen een lege pagina past — dan is er geen zinnige
 *   chunking mogelijk (een regel zo groot dat hij nooit ergens past is een sjabloonfout, geen
 *   paginabreukvraagstuk).
 */
function berekenChunks(meting) {
  const herhalend = meting.buitenTheadHoogte + meting.theadHoogte + meting.tfootHoogte;
  const capaciteitPagina1 = BRUIKBARE_HOOGTE_PX - herhalend - meting.eenmaligeKopHoogte;
  const capaciteitVervolgpagina = BRUIKBARE_HOOGTE_PX - herhalend;

  if (capaciteitPagina1 <= 0 || capaciteitVervolgpagina <= 0) {
    throw new Error(
      `D-10: berekende paginacapaciteit is niet-positief (pagina1=${capaciteitPagina1}px, vervolg=${capaciteitVervolgpagina}px) — kopinhoud past niet binnen één paginahoogte.`,
    );
  }

  const chunks = [];
  let huidig = [];
  let hoogteSoFar = 0;
  let capaciteit = capaciteitPagina1;

  for (const rij of meting.rijen) {
    if (huidig.length === 0 && rij.hoogte > capaciteit) {
      throw new Error(`D-10: een regel (${rij.hoogte}px) past op zichzelf al niet binnen een lege pagina (${capaciteit}px).`);
    }
    if (huidig.length > 0 && hoogteSoFar + rij.hoogte > capaciteit) {
      chunks.push(huidig);
      huidig = [];
      hoogteSoFar = 0;
      capaciteit = capaciteitVervolgpagina;
    }
    huidig.push(rij);
    hoogteSoFar += rij.hoogte;
  }
  if (huidig.length > 0) chunks.push(huidig);

  let lopendTotaal = 0;
  return chunks.map((rijenInChunk, idx) => {
    lopendTotaal += rijenInChunk.reduce((som, r) => som + r.aantal, 0);
    return {
      aantalRijen: rijenInChunk.length,
      cumulatiefTotaal: lopendTotaal,
      isLaatste: idx === chunks.length - 1,
    };
  });
}

/**
 * Herbouwt elke gemarkeerde tabel als N losse `<table>`-elementen (één per chunk), elk met zijn
 * eigen `<tbody>`-subset en een `<tfoot>` met het voor DIE pagina juiste cumulatieve getal. Elke
 * tabel na de eerste krijgt `break-before: page`, zodat de chunk-grens ook de paginagrens is —
 * dezelfde CSS-fragmentatie die de browser al gebruikt, nu expliciet in plaats van organisch.
 *
 * Puur DOM-manipulatie (geen HTML-stringbouw/regex): de bestaande `<thead>`/`<colgroup>` worden
 * gekloond, niet nagebouwd — een toekomstige kolomwijziging in happyflex-app kan deze stap dus
 * niet stil laten verouderen.
 */
async function herbouwMetChunks(page, chunksPerTabel) {
  await page.evaluate((chunksPerTabel) => {
    const tabellen = [...document.querySelectorAll('table[data-hf-paginacumulatief]')];
    tabellen.forEach((tabel, tabelIndex) => {
      const chunks = chunksPerTabel[tabelIndex];
      const thead = tabel.querySelector(':scope > thead');
      const colgroup = tabel.querySelector(':scope > colgroup');
      const tfoot = tabel.querySelector(':scope > tfoot');
      const tfootRij = tfoot.querySelector('tr');
      const cumKolom = Number(tfootRij.getAttribute('data-hf-cumulatief-kolom'));
      const labelKolom = Number(tfootRij.getAttribute('data-hf-label-kolom'));
      const labelTekst = tfootRij.getAttribute('data-hf-label') ?? '';
      const alleRijen = [...tabel.querySelectorAll(':scope > tbody > tr')];

      let rijCursor = 0;
      const nieuweTabellen = chunks.map((chunk, chunkIndex) => {
        const nieuw = document.createElement('table');
        nieuw.className = tabel.className;
        if (chunkIndex > 0) nieuw.style.breakBefore = 'page';
        if (colgroup) nieuw.appendChild(colgroup.cloneNode(true));
        nieuw.appendChild(thead.cloneNode(true));

        const tbody = document.createElement('tbody');
        for (let i = 0; i < chunk.aantalRijen; i++) {
          tbody.appendChild(alleRijen[rijCursor].cloneNode(true));
          rijCursor++;
        }
        nieuw.appendChild(tbody);

        const nieuweTfoot = tfoot.cloneNode(true);
        const cellen = nieuweTfoot.querySelector('tr').children;
        cellen[cumKolom].textContent = chunk.cumulatiefTotaalTekst;
        cellen[labelKolom].textContent = chunk.isLaatste ? '' : labelTekst;
        nieuw.appendChild(nieuweTfoot);

        return nieuw;
      });

      tabel.replaceWith(...nieuweTabellen);
    });
  }, chunksPerTabel);
}

/**
 * Controle NA het herbouwen (vóór het teruggeven van de PDF): het aantal pagina's dat de
 * herbouwde HTML daadwerkelijk print, moet exact het aantal chunks zijn dat berekend is. Wijkt
 * dat af — bijvoorbeeld omdat een chunk zelf tóch nog overloopt door een regel die net wél of
 * niet wrapt, een fontfallback of een afrondingsverschil tussen meting en eindrender — dan heeft
 * minstens één chunk zijn eigen pagina niet gehaald en klopt de cumulatieve telling niet meer.
 * Een verkeerd getal op een factuur is erger dan geen PDF: harde fout, geen document teruggeven.
 */
function verifieerPaginaAantal(werkelijkAantalPaginas, verwachtAantalPaginas) {
  if (werkelijkAantalPaginas !== verwachtAantalPaginas) {
    throw new Error(
      `D-10-verificatie mislukt: verwachtte ${verwachtAantalPaginas} pagina('s) na de cumulatieve herberekening, kreeg ${werkelijkAantalPaginas}. ` +
        'Meting en eindrender lopen uiteen (mogelijk een regel die net wel/niet wrapt) — geen PDF teruggegeven.',
    );
  }
}

/**
 * Past de volledige D-10-stap toe: detecteren, meten, chunken, herbouwen. Geeft het TOTAAL aantal
 * verwachte pagina's terug (som over alle gemarkeerde tabellen plus 1 als er geen marker was,
 * puur voor de verificatiestap na `page.pdf()`) — of `null` als er niets te doen viel.
 */
async function pasPaginaCumulatiefToe(page) {
  if (!(await heeftPaginacumulatieveTabel(page))) return null;

  // Print-media vóór het meten: `getBoundingClientRect()` moet de PRINTLAYOUT teruggeven (die
  // `page.pdf()` straks ook gebruikt), niet de schermlayout. Alleen aangeroepen op het pad dat al
  // weet dat er iets te doen valt — de rest van de renderpijplijn blijft ongemoeid.
  await page.emulateMediaType('print');

  // KRITIEK: `page.pdf({ format: 'A4' })` reflowt zijn print-uitvoer op de bruikbare PAGINABREEDTE
  // (170mm bij een marge van 20mm), niet op het standaard Puppeteer-viewport (800px). Zonder deze
  // regel meet je een omschrijvingskolom die BREDER is dan hij ooit print, en wrapt een lange
  // omschrijving bij het meten later (of niet) dan bij het echte printen — precies de "regel die
  // net wel of niet wrapt"-faalmodus. Leeg-geverifieerd: zonder deze regel faalde de
  // D-10-verificatie hieronder op elke render met een wrappende regel; met deze regel niet meer.
  await page.setViewport({ width: BRUIKBARE_BREEDTE_PX, height: METING_VIEWPORT_HOOGTE_PX });

  const metingen = await meetTabellen(page);
  const chunksPerTabel = metingen.map((meting) => {
    const chunks = berekenChunks(meting);
    return chunks.map((c) => ({ ...c, cumulatiefTotaalTekst: formatteerAantal(c.cumulatiefTotaal) }));
  });

  await herbouwMetChunks(page, chunksPerTabel);

  // Vandaag draagt een factuur/zelffactuur precies één gemarkeerde tabel; de som is toekomstvast
  // voor het geval dat ooit verandert, zonder een aanname over "precies één" hard te coderen.
  const verwachtAantalPaginas = chunksPerTabel.reduce((som, chunks) => som + chunks.length, 0);
  return verwachtAantalPaginas;
}

module.exports = { pasPaginaCumulatiefToe, verifieerPaginaAantal, berekenChunks, BRUIKBARE_HOOGTE_PX };
