'use strict';

// Zonder tijdstempel is een logregel niet te plaatsen op een tijdlijn — precies het probleem
// bij het uitpluizen van de laatste crash-loop. Alle info/warn/error-regels krijgen daarom een
// ISO-tijdstempel, ongeacht welke onderliggende logger (console, of stil in tests) er achter zit.

function metTijd(fn) {
  return (bericht, ...rest) => fn(`${new Date().toISOString()} ${bericht}`, ...rest);
}

function createLogger(basis = console) {
  return {
    info: metTijd(basis.info.bind(basis)),
    warn: metTijd(basis.warn.bind(basis)),
    error: metTijd(basis.error.bind(basis)),
  };
}

module.exports = { createLogger };
