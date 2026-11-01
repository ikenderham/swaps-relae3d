// Rummene: gå-kortet (gulv.json) og farten (figur_skala i rum.json) pr. rum, fra en mappe eller over
// HTTP(S) fra 3D-siden. Et rum hentes, første gang nogen skal ind i det, og igen efter RUM_FORNY_MS,
// så et nyt bagt rum slår igennem uden at relæet skal genstartes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Gaakort } from './gaakort.js';
import { kald } from './net.js';

const FART = 1.15;                  // m/s ved figur_skala 1, som klientens 3d/js/figur.js
const NAVN = /^[a-z0-9_-]{1,40}$/;  // mappenavnet i 3d/filer/rum
const RUM_FORNY_MS = 10 * 60000;
const RUM_FEJL_MS = 60000;          // et rum, der ikke kunne hentes, prøves tidligst igen om et minut
const HENT_MS = 8000;

export function lavRummene(kilde) {
  const overNet = /^https?:\/\//.test(kilde);
  const rod = overNet ? kilde : path.resolve(kilde);
  const rummene = new Map();   // navn -> { rum, til, henter }

  async function laes(navn, fil) {
    if (!overNet) return readFile(path.join(rod, navn, fil), 'utf8');
    // Adressen skifter ved hver fornyelse, så en cache foran 3D-siden ikke giver en gammel udgave
    const { status, tekst } = await kald(`${rod}/${navn}/${fil}?v=${Math.floor(Date.now() / RUM_FORNY_MS)}`, { ms: HENT_MS });
    if (status !== 200) throw new Error(`${fil}: status ${status}`);
    return tekst;
  }

  async function indlaes(navn) {
    const [gulv, info] = await Promise.all([laes(navn, 'gulv.json'), laes(navn, 'rum.json')]);
    const skala = JSON.parse(info).figur_skala;
    if (!(skala > 0)) throw new Error('rum.json mangler figur_skala');
    const kort = new Gaakort(JSON.parse(gulv));
    // Et punkt på gulvet bliver, hvor det er, ellers står man på den nærmeste gåbare celle (null: ingen inden for 3 m)
    const stil = (p) => {
      if (kort.paaGulvet(p)) return p;
      const k = kort.naermeste(p.x, p.z);
      return k < 0 ? null : kort.midte(k);
    };
    return { navn, kort, fart: FART * skala, stil, start: stil(kort.start) || kort.midte(kort.aabne[0]) };
  }

  return {
    kilde: rod,

    /** Rummet eller null, hvis det ikke findes. Et rum, der skal fornyes, bruges, mens det hentes igen. */
    hent(navn) {
      if (typeof navn !== 'string' || !NAVN.test(navn)) return Promise.resolve(null);
      let r = rummene.get(navn);
      if (!r) rummene.set(navn, r = { rum: null, til: 0, henter: null });
      if (Date.now() >= r.til && !r.henter) {
        r.henter = indlaes(navn)
          .then((rum) => { r.rum = rum; r.til = Date.now() + RUM_FORNY_MS; })
          .catch((fejl) => { r.til = Date.now() + RUM_FEJL_MS; console.warn(`[relae3d] rummet ${navn}: ${fejl.message}`); })
          .finally(() => { r.henter = null; });
      }
      return r.rum ? Promise.resolve(r.rum) : (r.henter || Promise.resolve()).then(() => r.rum);
    },

    /** Glemmer navne, der ikke kunne hentes, så de ikke hober sig op. */
    ryd() {
      const nu = Date.now();
      for (const [navn, r] of rummene) if (!r.rum && !r.henter && r.til <= nu) rummene.delete(navn);
    },
  };
}
