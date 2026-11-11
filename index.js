// Swaps 3D: realtids-relæet for den isometriske 3D-verden (tools/3d/PLAN_ISOMETRISK.md afsnit 18 og 20).
// Uden database: hvem man er, står i et HMAC-token fra 3D's PHP, og beskeder filtreres og gemmes af
// PHP (3d/besked.php). Relæet ved kun, hvem der er i hvilket rum, og hvor de går.
import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { punkt, tilNet, laengde, henne } from './vej.js';
import { lavRummene } from './rum.js';
import { kald } from './net.js';

// En fejl i én handling må ikke smide alle ud af 3D, indtil Render har startet relæet igen
process.on('unhandledRejection', (grund) => console.error('[relae3d] ubehandlet afvisning:', grund));
process.on('uncaughtException', (fejl) => console.error('[relae3d] ufanget fejl:', fejl));

const HEMMELIGHED = process.env.S3D_RELAE_HEMMELIGHED || '';
const PHP_BASE = (process.env.PHP_BASE || '').replace(/\/+$/, '');
const RUM_BASE = (process.env.RUM_BASE || '').replace(/\/+$/, '');
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = process.env.PORT === undefined ? 3013 : Number(process.env.PORT);
const COMMIT = (process.env.RENDER_GIT_COMMIT || 'lokal').slice(0, 7);

const HEMMELIGHED_MIN = 40;   // tegn; en kort hemmelighed kan gættes
// Uden standardværdier: et relæ, der af sig selv pegede på swaps.dk, kunne ramme den rigtige PHP fra en prøve
if (HEMMELIGHED.length < HEMMELIGHED_MIN || !PHP_BASE || !RUM_BASE || !CORS_ORIGIN.length) {
  console.error('[relae3d] S3D_RELAE_HEMMELIGHED (mindst 40 tegn), PHP_BASE, RUM_BASE og CORS_ORIGIN skal være sat');
  process.exit(1);
}

const VEJ_PUNKTER = 16;
const VEJ_MAKS_M = 30;
const START_AFVIG_M = 0.5;     // vejens første punkt mod relæets plads: tiden på nettet
const DOER_SLAEK_M = 0.3;      // ud over dørens radius, af samme grund
const TEKST_MAKS = 120;        // tegn (kodepunkter), som i 2D og i besked.php
const IND_FRIST_MS = 30000;    // en forbindelse, der ikke går ind, får intet og lukkes
const SMID_UD_MS = 10 * 60000;
const PHP_MS = 8000;
const TOKEN_MAKS = 2048;
const FELT_MAKS = 60;          // tegn i tokenets navn, figur og gender
// Navnereglerne er de samme som i PHP
const FIGUR = /^[a-z0-9_-]{1,40}$/;        // en figur i 3d/filer/figurer
const TOEJ_DELE = 8;
const BAAS = /^[a-z]{1,20}$/;
const TOEJ_FIL = /^[a-z0-9_-]{1,60}\.glb$/; // en tøjfil i 3d/filer/toej
const HANDLINGER = new Set(['hop', 'dans', 'nik', 'snur']);
const UDLOEB_SLAEK_MS = 60000; // så længe efter exp kan et ind-token nå at blive fornyet
const TIMER_MAKS_MS = 2 ** 31 - 1;
const NR_GLEM_MS = 11 * 60000; // længere end et ind-token lever, så et gammelt nr ikke kan bruges igen
const KOE_MAKS = 3;            // ventende beskeder pr. person
const KOE_VENT_MS = 10000;     // en besked, der har ventet længere, afvises
const PHP_AABNE_MAKS = 4;      // samtidige kald til besked.php
const BESKED_MAKS = 16 * 1024; // bytes pr. hændelse; den største er en vej med 16 punkter
const OPRYD_MS = 60000;
const ONLINE_MS = 5000;        // højst så tit går antallet online ud til alle
const INDE = 'inde';           // socket.io-rummet med alle, der er gået ind

const folk = new Map();        // id -> personen, som den står i sit rum
const smidtUd = new Map();     // id -> ms, hvor personen må komme ind igen
const kontoNr = new Map();     // id -> { sidst, <typ>: det seneste nr }, så et token ikke kan bruges igen
const rummene = lavRummene(RUM_BASE);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, online: folk.size, commit: COMMIT }));
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  serveClient: false,
  maxHttpBufferSize: BESKED_MAKS,
});

const hmac = (data) => crypto.createHmac('sha256', HEMMELIGHED).update(data).digest();

/**
 * Et token fra 3D's PHP: base64url(json).base64url(hmac_sha256(json)) med typ, id, iat og exp. Giver
 * indholdet, når signaturen passer, exp ikke er passeret, og typen er typ, ellers null. Et token uden typ
 * er et login (ind), som relae_token.php lavede dem før.
 */
function laesToken(token, typ) {
  if (typeof token !== 'string' || token.length > TOKEN_MAKS) return null;
  const dele = token.split('.');
  if (dele.length !== 2) return null;
  const json = Buffer.from(dele[0], 'base64url'), sig = Buffer.from(dele[1], 'base64url');
  const rigtig = hmac(json);
  if (sig.length !== rigtig.length || !crypto.timingSafeEqual(sig, rigtig)) return null;
  let k;
  try { k = JSON.parse(json.toString('utf8')); } catch { return null; }
  const id = Number(k && k.id);
  if (!Number.isSafeInteger(id) || id < 1 || !(Number(k.exp) > Date.now() / 1000)) return null;
  if ((k.typ === undefined ? 'ind' : k.typ) !== typ) return null;
  return { ...k, id };
}

/** Et token af typen typ, der gælder forbindelsens egen bruger, eller null. */
function egetToken(p, token, typ) {
  const k = laesToken(token, typ);
  return k && k.id === p.id ? k : null;
}

/**
 * Tøjet {bås: fil} fra et token: de dele, der følger navnereglen, højst TOEJ_DELE. En del, der ikke gør, smides
 * væk alene, og ældre tokens uden tøj (eller PHP's tomme []) giver intet tøj.
 */
function toejFra(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const gyldig = ([baas, fil]) => BAAS.test(baas) && typeof fil === 'string' && TOEJ_FIL.test(fil);
  return Object.fromEntries(Object.entries(v).filter(gyldig).slice(0, TOEJ_DELE));
}

const felt = (v) => String(v ?? '').slice(0, FELT_MAKS);
const erAdmin = (k) => k.admin === true || k.admin === 1;

/** Kontoens seneste nr pr. type, husket på tværs af forbindelser. */
function nrFor(id) {
  let d = kontoNr.get(id);
  if (!d) kontoNr.set(id, d = {});
  d.sidst = Date.now();
  return d;
}

/**
 * Typerne udseende, ting og ven bærer nr fra kontoens tæller. Giver null og husker nr, når det er nyere end
 * kontoens seneste af typen; et token, der kommer igen eller efter et nyere, er gammelt.
 */
function nrGrund(id, typ, nr) {
  if (!Number.isSafeInteger(nr)) return 'token';
  const d = nrFor(id);
  if (d[typ] !== undefined && nr <= d[typ]) return 'gammel';
  d[typ] = nr;
  return null;
}

// Et ind-token, der kan fornyes (med typ), lukkes ved exp plus slæk; de ældste uden typ kan klienten ikke forny
function saetUdloeb(p, k) {
  clearTimeout(p.udloeb);
  if (k.typ === undefined) return;
  p.udloeb = setTimeout(() => {
    if (folk.get(p.id) !== p) return;
    gaaUd(p);
    luk(p.socket, 'lukket', 'udloebet');
  }, Math.min(TIMER_MAKS_MS, Number(k.exp) * 1000 + UDLOEB_SLAEK_MS - Date.now()));
}

// Højst PHP_AABNE_MAKS kald til besked.php ad gangen; de andre venter på en plads
let phpAabne = 0;
const phpVenter = [];
function phpPlads() {
  if (phpAabne < PHP_AABNE_MAKS) {
    phpAabne++;
    return Promise.resolve();
  }
  return new Promise((ok) => phpVenter.push(ok));
}
function phpFri() {
  const naeste = phpVenter.shift();
  if (naeste) naeste();
  else phpAabne--;
}

/**
 * Personens beskeder går til PHP én ad gangen, i den rækkefølge de blev sagt. Står der KOE_MAKS i kø, eller har
 * en ventet over KOE_VENT_MS, afvises den med optaget. En, der er smidt ud, får intet sendt.
 */
function iKoe(p, hvad, opgave) {
  if (p.ventende >= KOE_MAKS) return afvis(p.socket, hvad, 'optaget');
  p.ventende++;
  const stillet = Date.now();
  p.sigKoe = p.sigKoe.then(async () => {
    await phpPlads();
    try {
      if (p.ude) return;
      if (Date.now() - stillet > KOE_VENT_MS) return afvis(p.socket, hvad, 'optaget');
      await opgave();
    } finally {
      phpFri();
      p.ventende--;
    }
  }).catch((fejl) => console.error('[relae3d] beskedkøen:', fejl));
}

/** POST til 3D's PHP med HMAC over den rå krop i X-S3D-Signatur. */
async function tilPhp(fil, data) {
  const krop = JSON.stringify(data);
  const { status, tekst } = await kald(`${PHP_BASE}/${fil}`, {
    metode: 'POST', krop, ms: PHP_MS,
    hoveder: { 'Content-Type': 'application/json', 'X-S3D-Signatur': hmac(krop).toString('base64url') },
  });
  let svar;
  try { svar = JSON.parse(tekst); } catch { throw new Error(`status ${status}, svaret er ikke JSON`); }
  // Et nej fra PHP har en grund, også med en anden status end 200
  if (!svar || (status !== 200 && svar.ok !== false)) throw new Error(`status ${status}`);
  return svar;
}

const kanal = (rum) => `rum:${rum}`;
const afvis = (socket, hvad, grund) => socket.emit('afvist', { hvad, grund });

/** Siger hvorfor og lukker forbindelsen; klienten forbinder ikke igen af sig selv efter de to. */
function luk(socket, haendelse, grund) {
  socket.emit(haendelse, { grund });
  socket.disconnect(true);
}

/** Hvor personen er nu, regnet af vejen og t0 som hos klienterne. En vej, der er gået til ende, bliver en plads. */
function plads(p, nu) {
  if (!p.vej) return { x: p.x, z: p.z };
  const meter = (nu - p.t0) / 1000 * p.rum.fart;
  if (meter < p.laengde) return henne(p.vej, meter);
  ({ x: p.x, z: p.z } = p.vej[p.vej.length - 1]);
  p.vej = null;
  return { x: p.x, z: p.z };
}

/** Personen, som de andre ser den; vej og t0 kun, mens den går. */
function vis(p, nu) {
  const { x, z } = plads(p, nu);
  const ud = { id: p.id, navn: p.navn, figur: p.figur, toej: p.toej, gender: p.gender, hudtone: p.hudtone, admin: p.admin, x, z };
  if (p.vej) Object.assign(ud, { vej: tilNet(p.vej), t0: p.t0 });
  return ud;
}

/** Personen står i rummet: rummet og antallet online til personen selv (med sig selv i folk), kom til de andre. */
function gaaInd(p, rum, sted) {
  Object.assign(p, { rum, x: sted.x, z: sted.z, vej: null });
  const nu = Date.now();
  p.socket.to(kanal(rum.navn)).emit('kom', { person: vis(p, nu) });
  p.socket.join(kanal(rum.navn));
  const her = [...folk.values()].filter((q) => q.rum.navn === rum.navn);
  p.socket.emit('rummet', { rum: rum.navn, nu, online: folk.size, folk: her.map((q) => vis(q, nu)) });
  p.socket.emit('online', onlineNu());
  meldOnline();
}

function forladRum(p) {
  p.socket.leave(kanal(p.rum.navn));
  io.to(kanal(p.rum.navn)).emit('gik', { id: p.id });
}

function gaaUd(p) {
  clearTimeout(p.udloeb);
  folk.delete(p.id);
  forladRum(p);
  meldOnline();
}

/** Antallet inde i hele 3D og pr. offentligt rum (rumnavnene i fast orden). */
function onlineNu() {
  const rum = new Map();
  for (const p of folk.values()) rum.set(p.rum.navn, (rum.get(p.rum.navn) || 0) + 1);
  return { antal: folk.size, rum: Object.fromEntries([...rum].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

// Antallet online til alle, der er inde, når det ændrer sig. Udsendelsen venter til efter den igangværende
// hændelse, så en konto, der forbinder igen (en ud, en ind), ikke ændrer tallet, og højst én går ud hvert ONLINE_MS.
let onlineSendt = '', onlineSidst = 0, onlineUr = null;
function meldOnline() {
  if (onlineUr) return;
  onlineUr = setTimeout(() => {
    onlineUr = null;
    const nu = onlineNu(), json = JSON.stringify(nu);
    if (json === onlineSendt) return;
    onlineSendt = json;
    onlineSidst = Date.now();
    io.to(INDE).emit('online', nu);
  }, Math.max(0, onlineSidst + ONLINE_MS - Date.now()));
}

async function sig(p, rum, tekst) {
  let svar;
  try {
    svar = await tilPhp('besked.php', { id: p.id, rum, tekst, tid: Math.floor(Date.now() / 1000) });
  } catch (fejl) {
    console.warn(`[relae3d] besked.php: ${fejl.message}`);
    return afvis(p.socket, 'sig', 'php');
  }
  if (svar.ok === true && typeof svar.tekst === 'string' && svar.tekst) {
    if (!p.ude) io.to(kanal(rum)).emit('sagde', { id: p.id, tekst: svar.tekst });
  } else {
    afvis(p.socket, 'sig', svar.ok === false && typeof svar.grund === 'string' && svar.grund ? svar.grund : 'php');
  }
}

// Bremse pr. konto, og før ind pr. forbindelse, så en ny forbindelse ikke giver fulde spande. Hver
// spand fyldes med prSek i sekundet op til ryk. Hændelser uden egen spand deler den strenge.
const BREMSE = {
  gaa: { prSek: 5, ryk: 5 },
  sig: { prSek: 1, ryk: 3 },
  skriver: { prSek: 2, ryk: 3 },
  skift: { prSek: 1, ryk: 2 },
  udseende: { prSek: 1, ryk: 5 }, // Garderoben gemmer flere skift i træk
  streng: { prSek: 1, ryk: 3 },   // ind, forny, handling, smid_ud og hændelser, relæet ikke kender
};
const HAENDELSER = new Set(['ind', 'forny', 'gaa', 'sig', 'skriver', 'skift', 'udseende', 'handling', 'smid_ud']);
const BREMSE_LUK = 200;           // afviste på BREMSE_VINDUE_MS er ikke en ivrig bruger, men et script
const BREMSE_VINDUE_MS = 10000;
const BREMSE_GLEM_MS = 60000;     // så længe efter sidste hændelse er spandene fulde igen
const kontoBremse = new Map();    // id -> { spande, afvist, sidst }

function bremseData(socket) {
  const p = socket.data.person;
  if (!p) return socket.data.bremse ??= { spande: {}, afvist: [] };
  let d = kontoBremse.get(p.id);
  if (!d) kontoBremse.set(p.id, d = { spande: {}, afvist: [] });
  d.sidst = Date.now();
  return d;
}

function bremseOk(socket, haendelse) {
  const slags = Object.hasOwn(BREMSE, haendelse) ? haendelse : 'streng';
  const { prSek, ryk } = BREMSE[slags];
  const d = bremseData(socket), nu = Date.now();
  const s = d.spande[slags] ??= { tokens: ryk, tid: nu };
  s.tokens = Math.min(ryk, s.tokens + (nu - s.tid) / 1000 * prSek);
  s.tid = nu;
  if (s.tokens >= 1) {
    s.tokens -= 1;
    return true;
  }
  d.afvist = d.afvist.filter((t) => nu - t < BREMSE_VINDUE_MS);
  d.afvist.push(nu);
  if (d.afvist.length >= BREMSE_LUK) {
    console.warn(`[relae3d] bremsen lukker ${socket.data.person ? socket.data.person.id : socket.id}`);
    luk(socket, 'lukket', 'for_mange');
  } else if (HAENDELSER.has(haendelse)) {
    afvis(socket, haendelse, 'for_hurtigt');
  }
  return false;
}

io.on('connection', (socket) => {
  socket.use(([haendelse], next) => { if (bremseOk(socket, haendelse)) next(); });
  const frist = setTimeout(() => { if (!socket.data.person) luk(socket, 'lukket', 'ingen_ind'); }, IND_FRIST_MS);
  socket.on('disconnect', () => {
    clearTimeout(frist);
    const p = socket.data.person;
    if (p && folk.get(p.id) === p) gaaUd(p);
  });

  socket.on('ind', async (d) => {
    if (socket.data.person || socket.data.paaVejInd) return afvis(socket, 'ind', 'allerede_inde');
    const k = laesToken(d && d.token, 'ind');
    if (!k) return afvis(socket, 'ind', 'token');
    socket.data.paaVejInd = true;
    const rum = await rummene.hent(d.rum);
    socket.data.paaVejInd = false;
    if (socket.disconnected) return;
    if ((smidtUd.get(k.id) || 0) > Date.now()) return luk(socket, 'smidt_ud', 'admin');
    if (!rum) return afvis(socket, 'ind', 'rum');
    // ind bærer udseende-tællerens værdi: lavere end kontoens seneste udseende er et token fra før det
    if (Number.isSafeInteger(k.nr)) {
      const nr = nrFor(k.id);
      if (nr.udseende !== undefined && k.nr < nr.udseende) return afvis(socket, 'ind', 'gammel');
      nr.udseende = Math.max(nr.udseende ?? k.nr, k.nr);
    }
    // Én forbindelse pr. konto: den gamle forlader sit rum og lukkes, før den nye kommer ind
    const gammel = folk.get(k.id);
    if (gammel) {
      gaaUd(gammel);
      luk(gammel.socket, 'lukket', 'ny_forbindelse');
    }
    const p = {
      id: k.id, navn: felt(k.navn), figur: felt(k.figur), toej: toejFra(k.toej), gender: felt(k.gender),
      hudtone: Number.isFinite(k.hudtone) ? k.hudtone : null, admin: erAdmin(k),
      socket, rum, x: 0, z: 0, vej: null, t0: 0, laengde: 0, skifter: false,
      sigKoe: Promise.resolve(), ventende: 0, ude: false, udloeb: null,
    };
    socket.data.person = p;
    folk.set(p.id, p);
    saetUdloeb(p, k);
    socket.join(INDE);
    clearTimeout(frist);
    const oensket = punkt([d.x, d.z]);
    gaaInd(p, rum, (oensket && rum.stil(oensket)) || rum.start);
  });

  socket.on('gaa', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'gaa', 'ikke_inde');
    const raa = d && d.vej;
    if (!Array.isArray(raa) || raa.length < 2) return afvis(socket, 'gaa', 'data');
    if (raa.length > VEJ_PUNKTER) return afvis(socket, 'gaa', 'for_mange_punkter');
    const vej = raa.map(punkt);
    if (vej.includes(null)) return afvis(socket, 'gaa', 'data');
    const { kort } = p.rum;
    if (!vej.every((q, k) => kort.paaGulvet(q) && (k === 0 || kort.sigt(vej[k - 1], q)))) {
      return afvis(socket, 'gaa', 'uden_for_gulvet');
    }
    const m = laengde(vej);
    if (m > VEJ_MAKS_M) return afvis(socket, 'gaa', 'for_lang');
    const nu = Date.now();
    const her = plads(p, nu);
    if (Math.hypot(vej[0].x - her.x, vej[0].z - her.z) > START_AFVIG_M) return afvis(socket, 'gaa', 'for_langt_fra');
    Object.assign(p, { vej, t0: nu, laengde: m });
    io.to(kanal(p.rum.navn)).emit('gaar', { id: p.id, vej: tilNet(vej), t0: nu });
  });

  socket.on('forny', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'forny', 'ikke_inde');
    const k = egetToken(p, d && d.token, 'ind');
    if (!k) return afvis(socket, 'forny', 'token');
    Object.assign(p, { navn: felt(k.navn), admin: erAdmin(k) });
    saetUdloeb(p, k);
  });

  socket.on('sig', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'sig', 'ikke_inde');
    if (typeof (d && d.tekst) !== 'string') return afvis(socket, 'sig', 'data');
    const tekst = d.tekst.trim();
    if (!tekst) return afvis(socket, 'sig', 'tom');
    if ([...tekst].length > TEKST_MAKS) return afvis(socket, 'sig', 'for_lang_tekst');
    // Beskeden hører til det rum, den blev sagt i
    const rum = p.rum.navn;
    iKoe(p, 'sig', () => sig(p, rum, tekst));
  });

  socket.on('skriver', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'skriver', 'ikke_inde');
    socket.to(kanal(p.rum.navn)).emit('skriver', { id: p.id, ja: (d && d.ja) === true });
  });

  socket.on('skift', async (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'skift', 'ikke_inde');
    if (p.skifter) return afvis(socket, 'skift', 'for_hurtigt');
    const maal = d && d.rum, via = d && d.via;
    const gennemDoer = via !== undefined && via !== null;
    if (typeof maal !== 'string' || (gennemDoer && via !== maal)) return afvis(socket, 'skift', 'data');
    if (maal === p.rum.navn) return afvis(socket, 'skift', 'samme_rum');
    const fra = p.rum;
    if (gennemDoer) {
      const doere = fra.kort.doere.filter((doer) => doer.til === via);
      if (!doere.length) return afvis(socket, 'skift', 'ingen_doer');
      const her = plads(p, Date.now());
      const ved = (doer) => Math.hypot(her.x - doer.x, her.z - doer.z) <= doer.r + DOER_SLAEK_M;
      if (!doere.some(ved)) return afvis(socket, 'skift', 'ikke_ved_doeren');
    }
    p.skifter = true;
    const rum = await rummene.hent(maal);
    p.skifter = false;
    if (folk.get(p.id) !== p) return;
    if (!rum) return afvis(socket, 'skift', 'rum');
    // Gennem en dør står man ved målrummets dør tilbage; fra rumlisten, eller uden en dør tilbage, på start
    const tilbage = gennemDoer && rum.kort.doere.find((doer) => doer.til === fra.navn);
    forladRum(p);
    gaaInd(p, rum, (tilbage && rum.stil(tilbage.ind)) || rum.start);
  });

  socket.on('udseende', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'udseende', 'ikke_inde');
    const k = egetToken(p, d && d.token, 'udseende');
    if (!k) return afvis(socket, 'udseende', 'token');
    if (typeof k.figur !== 'string' || !FIGUR.test(k.figur)) return afvis(socket, 'udseende', 'data');
    const grund = nrGrund(p.id, 'udseende', k.nr);
    if (grund) return afvis(socket, 'udseende', grund);
    const toej = toejFra(k.toej);
    Object.assign(p, { figur: k.figur, toej });
    io.to(kanal(p.rum.navn)).emit('udseende', { id: p.id, figur: p.figur, toej });
  });

  socket.on('handling', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'handling', 'ikke_inde');
    const navn = d && d.navn;
    if (!HANDLINGER.has(navn)) return afvis(socket, 'handling', 'data');
    io.to(kanal(p.rum.navn)).emit('handling', { id: p.id, navn });
  });

  socket.on('smid_ud', (d) => {
    const p = socket.data.person;
    if (!p) return afvis(socket, 'smid_ud', 'ikke_inde');
    if (!p.admin) return afvis(socket, 'smid_ud', 'ikke_admin');
    const id = Number(d && d.id);
    if (id === p.id) return afvis(socket, 'smid_ud', 'dig_selv');
    const q = folk.get(id);
    if (!q) return afvis(socket, 'smid_ud', 'ikke_online');
    if (q.admin) return afvis(socket, 'smid_ud', 'admin');
    smidtUd.set(id, Date.now() + SMID_UD_MS);
    q.ude = true;   // beskeder i kø går hverken til PHP eller til rummet
    gaaUd(q);
    luk(q.socket, 'smidt_ud', 'admin');
  });
});

// Oprydning: spande, der er fulde igen, udløbne udsmidninger, glemte nr og rumnavne, der ikke fandtes
setInterval(() => {
  const nu = Date.now();
  for (const [id, d] of kontoBremse) if (nu - d.sidst > BREMSE_GLEM_MS) kontoBremse.delete(id);
  for (const [id, til] of smidtUd) if (til <= nu) smidtUd.delete(id);
  for (const [id, d] of kontoNr) if (nu - d.sidst > NR_GLEM_MS) kontoNr.delete(id);
  rummene.ryd();
}, OPRYD_MS).unref();

server.listen(PORT, () => {
  console.log(`[relae3d] lytter på port ${server.address().port} (pid ${process.pid}, commit ${COMMIT}), rum fra ${rummene.kilde}, PHP på ${PHP_BASE}`);
});
