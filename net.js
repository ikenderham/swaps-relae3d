// HTTP ud af relæet: rumfilerne og 3D's PHP. Det går gennem http-modulet og ikke fetch, fordi Windows
// ikke slår *.localhost op; et localhost-navn er altid maskinen selv (RFC 6761), som i browserne.
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';

const SVAR_MAKS = 1 << 20;   // bytes; et gulv.json fylder nogle få KB

function opslag(navn, valg, svar) {
  if (navn !== 'localhost' && !navn.endsWith('.localhost')) return lookup(navn, valg, svar);
  if (valg.all) svar(null, [{ address: '127.0.0.1', family: 4 }]);
  else svar(null, '127.0.0.1', 4);
}

/** Én forespørgsel. Giver { status, tekst }; afviser ved netfejl, for stort svar, eller når ms er gået. */
export function kald(adresse, { metode = 'GET', krop, hoveder, ms }) {
  return new Promise((ok, fejl) => {
    const url = new URL(adresse);
    const valg = { method: metode, headers: hoveder, lookup: opslag, signal: AbortSignal.timeout(ms) };
    const req = (url.protocol === 'https:' ? https : http).request(url, valg, (res) => {
      const dele = [];
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n > SVAR_MAKS) req.destroy(new Error('for stort svar'));
        else dele.push(d);
      });
      res.on('end', () => ok({ status: res.statusCode, tekst: Buffer.concat(dele).toString('utf8') }));
      res.on('error', fejl);
    });
    req.on('error', fejl);
    req.end(krop);
  });
}
