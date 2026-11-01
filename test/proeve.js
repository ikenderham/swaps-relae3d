// Prøver for relæet: et relæ på en tilfældig port med tre små prøverum og en stub af 3D's PHP, og
// socket.io-klienter, der går ind, går, taler, skifter rum og smides ud. Kør: npm test
// Hemmeligheden laves her og findes kun i prøvens hukommelse; relæet kan ikke nå andet end stubben.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { henne as henneXz } from '../vej.js';

const RELAE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KLIENTENS_GAAKORT = path.join(RELAE, '..', '3d', 'js', 'gaakort.js');
const HEMMELIGHED = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://swaps3d.localhost';
const FART = 1.15;
const VENT_MS = 2000;

const sov = (ms) => new Promise((ok) => setTimeout(ok, ms));
const naer = (a, b, slaek = 1e-9) => Math.abs(a - b) < slaek;

/** Hvor en klient er nået til på en vej [[x, z], ...], som [x, z]. */
function henne(vej, meter) {
  const p = henneXz(vej.map(([x, z]) => ({ x, z })), meter);
  return [p.x, p.z];
}

// ---- Prøverummene: gåbart overalt i b x h celler på 10 cm undtagen de lukkede [i0, j0, i1, j1) ----

const RUMMAPPE = fs.mkdtempSync(path.join(os.tmpdir(), 'relae3d-'));

function lavRum(navn, { x0, z0, b, h, lukket = [], start, doere = [], skala = 1 }) {
  const bits = Buffer.alloc(Math.ceil(b * h / 8));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < b; i++) {
      if (lukket.some(([i0, j0, i1, j1]) => i >= i0 && i < i1 && j >= j0 && j < j1)) continue;
      const k = j * b + i;
      bits[k >> 3] |= 1 << (k & 7);
    }
  }
  fs.mkdirSync(path.join(RUMMAPPE, navn));
  const gulv = { version: 1, celle: 0.1, x0, z0, b, h, gaa: bits.toString('base64'), start, doere };
  fs.writeFileSync(path.join(RUMMAPPE, navn, 'gulv.json'), JSON.stringify(gulv));
  fs.writeFileSync(path.join(RUMMAPPE, navn, 'rum.json'), JSON.stringify({ titel: navn, figur_skala: skala }));
}

// Gaden: 4 x 2 m med en mur ved x 2,0-2,1 fra z 0 til 1,5; man kommer forbi den nederst
lavRum('gade', {
  x0: 0, z0: 0, b: 40, h: 20, lukket: [[20, 0, 21, 15]], start: [0.55, 0.55],
  doere: [
    { til: 'cafe', x: 3.8, z: 0.2, r: 0.3, ind: [3.5, 0.5] },
    { til: 'kaelder', x: 0.2, z: 1.8, r: 0.3, ind: [0.5, 1.5] },
  ],
});
// Caféen: 2 x 2 m, figurerne dobbelt så store og dermed dobbelt så hurtige
lavRum('cafe', {
  x0: -1, z0: -1, b: 20, h: 20, start: [0.05, 0.05], skala: 2,
  doere: [{ til: 'gade', x: -0.8, z: -0.8, r: 0.3, ind: [-0.45, -0.45] }],
});
// Kælderen har ingen dør tilbage: man lander på start
lavRum('kaelder', { x0: 0, z0: 0, b: 10, h: 10, start: [0.55, 0.55] });

// ---- Stubben af 3D's PHP: besked.php som planen, og rumfilerne over HTTP ----

const beskeder = [];   // de beskeder, hvis signatur PHP har godkendt
const rumHentet = [];  // adresserne på de rumfiler, relæet har hentet over HTTP

function svar(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

const stub = http.createServer((req, res) => {
  const dele = [];
  req.on('data', (d) => dele.push(d));
  req.on('end', async () => {
    const krop = Buffer.concat(dele).toString('utf8');
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname.startsWith('/rum/')) {
      rumHentet.push(req.url);
      const fil = path.join(RUMMAPPE, ...url.pathname.split('/').slice(2));
      return fs.existsSync(fil) ? svar(res, 200, fs.readFileSync(fil, 'utf8')) : svar(res, 404, {});
    }
    if (req.method !== 'POST' || url.pathname !== '/3d/besked.php') return svar(res, 404, {});
    // Uden længden får PHP bag en proxy ofte en tom krop
    if (!req.headers['content-length']) return svar(res, 411, { ok: false, grund: 'laengde' });
    const rigtig = crypto.createHmac('sha256', HEMMELIGHED).update(krop).digest('base64url');
    if (req.headers['x-s3d-signatur'] !== rigtig) return svar(res, 403, { ok: false, grund: 'signatur' });
    const b = JSON.parse(krop);
    if (Math.abs(Date.now() / 1000 - b.tid) > 30) return svar(res, 403, { ok: false, grund: 'tid' });
    beskeder.push(b);
    const vent = /^vent(\d+)/.exec(b.tekst);
    if (vent) await sov(Number(vent[1]));
    if (b.tekst.includes('php_fejl')) return svar(res, 500, '<b>Fatal error</b>');
    if (b.tekst.includes('forbudt')) return svar(res, 200, { ok: false, grund: 'ordfilter' });
    svar(res, 200, { ok: true, tekst: b.tekst.replace(/lort/g, '****') });
  });
});
await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
const STUB = stub.address().port;

// ---- Relæet som egen proces ----

const relaeer = [];

function startRelae(env) {
  return new Promise((ok, fejl) => {
    const barn = spawn(process.execPath, ['index.js'], {
      cwd: RELAE,
      env: { ...process.env, S3D_RELAE_HEMMELIGHED: HEMMELIGHED, CORS_ORIGIN: ORIGIN, PORT: '0', RENDER_GIT_COMMIT: '', ...env },
    });
    relaeer.push(barn);
    barn.log = '';
    barn.stdout.on('data', (d) => {
      barn.log += d;
      const m = /port (\d+)/.exec(barn.log);
      if (m && !barn.port) ok(Object.assign(barn, { port: Number(m[1]) }));
    });
    barn.stderr.on('data', (d) => { barn.log += d; });
    barn.on('exit', (kode) => { if (!barn.port) fejl(new Error(`relæet stoppede (${kode}): ${barn.log}`)); });
  });
}

/** Et token som 3d/relae_token.php laver det: base64url(json).base64url(hmac_sha256(json)). */
function token(krav, hemmelighed = HEMMELIGHED) {
  const nu = Math.floor(Date.now() / 1000);
  const json = JSON.stringify({ figur: 'hvid-mand', gender: 'm', hudtone: 0, admin: false, iat: nu, exp: nu + 2700, ...krav });
  return `${Buffer.from(json).toString('base64url')}.${crypto.createHmac('sha256', hemmelighed).update(json).digest('base64url')}`;
}

function hentJson(adresse) {
  return new Promise((ok, fejl) => {
    http.get(adresse, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => ok(JSON.parse(t)));
    }).on('error', fejl);
  });
}

/** En socket.io-klient med en postkasse, så en hændelse ikke går tabt, før prøven venter på den. */
class Klient {
  constructor(port) {
    this.post = [];
    this.venter = [];
    this.s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: { origin: ORIGIN } });
    this.s.onAny((h, d) => this.modtag(h, d));
    this.s.on('disconnect', (grund) => this.modtag('disconnect', grund));
  }

  modtag(h, d) {
    this.post.push({ h, d });
    for (const v of [...this.venter]) this.tjek(v);
  }

  tjek(v) {
    const i = this.post.findIndex((x) => x.h === v.h && v.filter(x.d));
    if (i < 0) return;
    const [x] = this.post.splice(i, 1);
    this.venter.splice(this.venter.indexOf(v), 1);
    clearTimeout(v.ur);
    v.ok(x.d);
  }

  /** Den første hændelse af den slags (som passer på filteret), der ikke er brugt endnu. */
  vent(h, filter = () => true, ms = VENT_MS) {
    return new Promise((ok, fejl) => {
      const v = { h, filter, ok };
      v.ur = setTimeout(() => {
        this.venter.splice(this.venter.indexOf(v), 1);
        fejl(new Error(`ventede forgæves på ${h}; postkassen: ${JSON.stringify(this.post).slice(0, 400)}`));
      }, ms);
      this.venter.push(v);
      this.tjek(v);
    });
  }

  spoerg(haendelse, data, svar) {
    this.s.emit(haendelse, data);
    return this.vent(svar);
  }

  async afvist(haendelse, data, grund) {
    const a = await this.spoerg(haendelse, data, 'afvist');
    assert.deepEqual(a, { hvad: haendelse, grund }, `${haendelse} ${JSON.stringify(data).slice(0, 80)}`);
  }

  /** Ingen hændelse af den slags inden for ms. */
  async ingen(h, ms = 300) {
    await sov(ms);
    const x = this.post.find((y) => y.h === h);
    assert.ok(!x, `uventet ${h}: ${JSON.stringify(x && x.d)}`);
  }

  ind(tok, rum, x, z) {
    return this.spoerg('ind', { token: tok, rum, x, z }, 'rummet');
  }

  luk() {
    this.s.disconnect();
  }
}

async function proeve(navn, fn) {
  await fn();
  console.log(`ok   ${navn}`);
}

// A, C og E er testere, B og D admins
const A = { id: 101, navn: 'ZZa' }, B = { id: 102, navn: 'ZZb', admin: true }, C = { id: 103, navn: 'ZZc' };
const D = { id: 104, navn: 'ZZd', admin: true }, E = { id: 105, navn: 'ZZe' };

const klienter = [];
let fejlet = false;

try {
  const relae = await startRelae({ PHP_BASE: `http://127.0.0.1:${STUB}/3d`, RUM_BASE: RUMMAPPE });
  const P = relae.port;
  const ny = (port = P) => { const k = new Klient(port); klienter.push(k); return k; };
  const online = async () => (await hentJson(`http://127.0.0.1:${P}/health`)).online;

  // Uden klientens fil ved siden af (relæets eget arkiv alene) er der intet at sammenligne med
  if (fs.existsSync(KLIENTENS_GAAKORT)) {
    await proeve('gaakort.js er byte for byte klientens 3d/js/gaakort.js', async () => {
      assert.ok(fs.readFileSync(path.join(RELAE, 'gaakort.js')).equals(fs.readFileSync(KLIENTENS_GAAKORT)),
        'relae3d/gaakort.js er ikke længere klientens: kør npm run gaakort');
    });
  } else {
    console.log('-    gaakort.js sammenlignes ikke: 3d/js/gaakort.js ligger ikke ved siden af relæet');
  }

  await proeve('/health svarer ok, online og commit', async () => {
    assert.deepEqual(await hentJson(`http://127.0.0.1:${P}/health`), { ok: true, online: 0, commit: 'lokal' });
  });

  const a = ny(), b = ny();

  await proeve('uden ind afvises alt andet', async () => {
    await a.afvist('gaa', { vej: [[0.55, 0.55], [1, 0.55]] }, 'ikke_inde');
    await a.afvist('sig', { tekst: 'hej' }, 'ikke_inde');
  });

  await proeve('forkerte, udløbne og pillede tokens afvises', async () => {
    const [krop, sig] = token(A).split('.');
    const pillet = { ...JSON.parse(Buffer.from(krop, 'base64url').toString()), admin: true };
    const forkerte = [
      'noget.vroevl',
      token(A, 'en anden hemmelighed, der også er mindst fyrre tegn lang'),
      token({ ...A, exp: Math.floor(Date.now() / 1000) - 1 }),
      `${Buffer.from(JSON.stringify(pillet)).toString('base64url')}.${sig}`,
      token({ ...A, id: 0 }),
    ];
    // Hver på sin egen forbindelse: før ind har forbindelsen sin egen strenge spand
    for (const t of forkerte) await ny().afvist('ind', { token: t, rum: 'gade' }, 'token');
  });

  await proeve('ukendte rum afvises', async () => {
    await ny().afvist('ind', { token: token(A), rum: 'findes_ikke' }, 'rum');
    await ny().afvist('ind', { token: token(A), rum: '../gade' }, 'rum');
  });

  await proeve('A går ind og står, hvor A bad om; et ind mere afvises', async () => {
    const r = await a.ind(token(A), 'gade', 0.55, 0.55);
    assert.equal(r.rum, 'gade');
    assert.ok(Math.abs(r.nu - Date.now()) < 1000);
    assert.deepEqual(r.folk, [{ id: 101, navn: 'ZZa', figur: 'hvid-mand', gender: 'm', hudtone: 0, admin: false, x: 0.55, z: 0.55 }]);
    await a.afvist('ind', { token: token(A), rum: 'gade' }, 'allerede_inde');
  });

  await proeve('B kommer ind uden for gulvet, står på nærmeste celle og ser A; A ser B komme', async () => {
    const r = await b.ind(token(B), 'gade', 1.03, 2.3);
    const selv = r.folk.find((p) => p.id === 102);
    assert.ok(naer(selv.x, 1.05) && naer(selv.z, 1.95), JSON.stringify(selv));
    assert.deepEqual(r.folk.map((p) => p.id).sort(), [101, 102]);
    const k = await a.vent('kom');
    assert.equal(k.person.id, 102);
    assert.equal(k.person.admin, true);
    assert.ok(naer(k.person.x, 1.05) && naer(k.person.z, 1.95));
    assert.equal(await online(), 2);
  });

  await proeve('en gyldig vej går til alle i rummet, også afsenderen', async () => {
    const vej = [[0.55, 0.55], [1.55, 0.55]];
    a.s.emit('gaa', { vej });
    const [ga, gb] = await Promise.all([a.vent('gaar'), b.vent('gaar')]);
    assert.deepEqual(ga, gb);
    assert.equal(ga.id, 101);
    assert.deepEqual(ga.vej, vej);
    assert.ok(Math.abs(ga.t0 - Date.now()) < 1000);
  });

  await proeve('ugyldige veje afvises: uden for gulvet, gennem muren, for mange punkter, for lang, for langt fra', async () => {
    await sov(1000);   // gaa: fem i træk
    await a.afvist('gaa', { vej: [[0.55, 0.55], [0.55, 2.5]] }, 'uden_for_gulvet');
    await a.afvist('gaa', { vej: [[1.55, 0.55], [2.55, 0.55]] }, 'uden_for_gulvet');
    await a.afvist('gaa', { vej: Array.from({ length: 17 }, (_, k) => [0.55 + k * 0.05, 0.55]) }, 'for_mange_punkter');
    await a.afvist('gaa', { vej: [[0.55, 0.55]] }, 'data');
    await a.afvist('gaa', { vej: [[0.55, 0.55], [1, 'x']] }, 'data');
    await sov(1000);
    // 15 diagonaler på 2,4 m mellem to hjørner foran muren: 36 m
    const zigzag = Array.from({ length: 16 }, (_, k) => (k % 2 ? [1.85, 1.85] : [0.15, 0.15]));
    await a.afvist('gaa', { vej: zigzag }, 'for_lang');
    await a.afvist('gaa', { vej: [[3.5, 0.5], [3.6, 0.5]] }, 'for_langt_fra');
    await b.ingen('gaar');
    await sov(1000);
  });

  let gang;
  await proeve('relæet regner pladsen af vej og t0: en vej fra det gamle sted afvises, fra det rigtige går den', async () => {
    const vej = [[1.55, 0.55], [1.55, 1.85], [3.55, 1.85]];
    a.s.emit('gaa', { vej });
    const g = await a.vent('gaar');
    await b.vent('gaar');
    await sov(1000);
    await a.afvist('gaa', { vej: [[1.55, 0.55], [1.55, 0.65]] }, 'for_langt_fra');
    const her = henne(vej, (Date.now() - g.t0) / 1000 * FART);
    a.s.emit('gaa', { vej: [her, [3.55, 1.85]] });
    gang = await a.vent('gaar');
    assert.deepEqual(gang.vej, [her, [3.55, 1.85]]);
    await b.vent('gaar');
  });

  await proeve('skriver går til de andre i rummet, ikke til afsenderen', async () => {
    a.s.emit('skriver', { ja: true });
    assert.deepEqual(await b.vent('skriver'), { id: 101, ja: true });
    await a.ingen('skriver');
  });

  await proeve('sig går gennem PHP, og PHP\'s tekst går til hele rummet', async () => {
    const [sa, sb] = await Promise.all([a.spoerg('sig', { tekst: '  hej med dig  ' }, 'sagde'), b.vent('sagde')]);
    assert.deepEqual(sa, { id: 101, tekst: 'hej med dig' });
    assert.deepEqual(sb, sa);
    const sidst = beskeder[beskeder.length - 1];
    assert.deepEqual({ id: sidst.id, rum: sidst.rum, tekst: sidst.tekst }, { id: 101, rum: 'gade', tekst: 'hej med dig' });
    const [filtreret] = await Promise.all([a.spoerg('sig', { tekst: 'det er lort' }, 'sagde'), b.vent('sagde')]);
    assert.equal(filtreret.tekst, 'det er ****');
  });

  await proeve('PHP\'s nej går kun tilbage til afsenderen, med PHP\'s grund', async () => {
    await b.afvist('sig', { tekst: 'et forbudt ord' }, 'ordfilter');
    await a.ingen('sagde');
  });

  await proeve('for lang og tom tekst afvises uden at spørge PHP; de 120 tegn er tegn, ikke UTF-16', async () => {
    const foer = beskeder.length;
    await b.afvist('sig', { tekst: 'x'.repeat(121) }, 'for_lang_tekst');
    await b.afvist('sig', { tekst: '   ' }, 'tom');
    assert.equal(beskeder.length, foer);
    await sov(1100);   // sig: tre i træk, så én i sekundet
    const emoji = '😀'.repeat(120);
    const [s] = await Promise.all([b.spoerg('sig', { tekst: emoji }, 'sagde'), a.vent('sagde')]);
    assert.equal(s.tekst, emoji);
  });

  await proeve('svarer PHP med en fejl, afvises beskeden med php', async () => {
    await a.afvist('sig', { tekst: 'php_fejl' }, 'php');
    await b.ingen('sagde');
  });

  await proeve('beskederne kommer frem i den rækkefølge, de blev sagt, også når PHP svarer omvendt', async () => {
    await sov(3000);
    for (const t of ['vent300 en', 'vent150 to', 'vent0 tre']) a.s.emit('sig', { tekst: t });
    const set = [];
    for (let k = 0; k < 3; k++) set.push((await b.vent('sagde')).tekst);
    assert.deepEqual(set, ['vent300 en', 'vent150 to', 'vent0 tre']);
    for (let k = 0; k < 3; k++) await a.vent('sagde');
  });

  await proeve('skift gennem en dør kræver en dør til rummet, og at man står i den', async () => {
    await a.afvist('skift', { rum: 'cafe', via: 'cafe' }, 'ikke_ved_doeren');
    await a.afvist('skift', { rum: 'cafe', via: 'kaelder' }, 'data');
    await sov(2000);   // skift: to i træk
    await a.afvist('skift', { rum: 'loftet', via: 'loftet' }, 'ingen_doer');
    await a.afvist('skift', { rum: 'gade' }, 'samme_rum');
  });

  await proeve('døren har 0,3 m slæk ud over sin radius: 0,65 m fra midten afvises', async () => {
    // Døren til caféen har midten (3,8, 0,2) og radius 0,3
    const her = henne(gang.vej, (Date.now() - gang.t0) / 1000 * FART);
    a.s.emit('gaa', { vej: [her, [3.8, 0.85]] });
    await a.vent('gaar');
    await b.vent('gaar');
    await sov(1100);
    await a.afvist('skift', { rum: 'cafe', via: 'cafe' }, 'ikke_ved_doeren');
  });

  await proeve('0,45 m fra dørens midte, uden for cirklen men inden for slækket, går A ind i caféen ved dens dør tilbage; B ser A gå', async () => {
    a.s.emit('gaa', { vej: [[3.8, 0.85], [3.8, 0.65]] });
    await a.vent('gaar');
    await b.vent('gaar');
    await sov(1000);   // skift: én i sekundet
    const r = await a.spoerg('skift', { rum: 'cafe', via: 'cafe' }, 'rummet');
    assert.equal(r.rum, 'cafe');
    assert.deepEqual(r.folk.map((p) => [p.id, p.x, p.z]), [[101, -0.45, -0.45]]);
    assert.deepEqual(await b.vent('gik'), { id: 101 });
  });

  let rundtur;
  await proeve('farten følger rummets figur_skala (caféen: dobbelt)', async () => {
    const vej = [[-0.45, -0.45], [0.85, -0.45], [0.85, 0.85]];
    a.s.emit('gaa', { vej });
    const g = await a.vent('gaar');
    await sov(500);
    // Med farten uden skala stod relæets figur 0,575 m længere tilbage, og vejen blev afvist
    const her = henne(vej, (Date.now() - g.t0) / 1000 * FART * 2);
    a.s.emit('gaa', { vej: [her, [0.85, 0.85]] });
    await a.vent('gaar');
    await sov(800);
    a.s.emit('gaa', { vej: [[0.85, 0.85], [0.85, -0.85], [-0.85, -0.85], [-0.85, 0.85], [0.75, 0.85]] });
    rundtur = await a.vent('gaar');
  });

  await proeve('B skifter fra rumlisten til caféens start og ser A gå med vej og t0; A ser B komme', async () => {
    const r = await b.spoerg('skift', { rum: 'cafe' }, 'rummet');
    assert.equal(r.rum, 'cafe');
    const ra = r.folk.find((p) => p.id === 101), rb = r.folk.find((p) => p.id === 102);
    assert.deepEqual([rb.x, rb.z], [0.05, 0.05]);
    assert.equal(rb.vej, undefined);
    assert.deepEqual([ra.vej, ra.t0], [rundtur.vej, rundtur.t0]);
    const forventet = henne(rundtur.vej, (r.nu - rundtur.t0) / 1000 * FART * 2);
    assert.ok(naer(ra.x, forventet[0], 1e-6) && naer(ra.z, forventet[1], 1e-6), JSON.stringify([ra, forventet]));
    assert.equal((await a.vent('kom')).person.id, 102);
    await b.afvist('skift', { rum: 'cafe' }, 'samme_rum');
  });

  const c = ny(), d = ny();
  await proeve('gennem en dør til et rum uden dør tilbage lander man på start', async () => {
    await c.ind(token(C), 'gade', 0.25, 1.75);
    const r = await c.spoerg('skift', { rum: 'kaelder', via: 'kaelder' }, 'rummet');
    assert.deepEqual(r, { rum: 'kaelder', nu: r.nu, folk: [{ id: 103, navn: 'ZZc', figur: 'hvid-mand', gender: 'm', hudtone: 0, admin: false, x: 0.55, z: 0.55 }] });
  });

  await proeve('smid_ud: kun admins, ikke sig selv, ikke en anden admin, kun en, der er her', async () => {
    await d.ind(token(D), 'kaelder', 0.35, 0.35);
    assert.equal((await c.vent('kom')).person.id, 104);
    await a.afvist('smid_ud', { id: 103 }, 'ikke_admin');
    await b.afvist('smid_ud', { id: 102 }, 'dig_selv');
    await b.afvist('smid_ud', { id: 999 }, 'ikke_online');
    await b.afvist('smid_ud', { id: 104 }, 'admin');
    await sov(1100);   // smid_ud har den strenge spand: tre i træk
  });

  await proeve('en admin smider en ud: personen får smidt_ud og lukkes, rummet ser den gå, og den kan ikke komme ind igen', async () => {
    b.s.emit('smid_ud', { id: 103 });
    assert.deepEqual(await c.vent('smidt_ud'), { grund: 'admin' });
    assert.equal(await c.vent('disconnect'), 'io server disconnect');
    assert.deepEqual(await d.vent('gik'), { id: 103 });
    const igen = ny();
    igen.s.emit('ind', { token: token(C), rum: 'gade' });
    assert.deepEqual(await igen.vent('smidt_ud'), { grund: 'admin' });
    assert.equal(await igen.vent('disconnect'), 'io server disconnect');
  });

  const a2 = ny();
  await proeve('samme konto på en ny forbindelse lukker den gamle med lukket', async () => {
    const r = await a2.ind(token(A), 'gade', 0.55, 0.55);
    assert.deepEqual(r.folk.map((p) => p.id), [101]);
    assert.deepEqual(await a.vent('lukket'), { grund: 'ny_forbindelse' });
    assert.equal(await a.vent('disconnect'), 'io server disconnect');
    assert.deepEqual(await b.vent('gik'), { id: 101 });
    assert.equal(await online(), 3);
  });

  await proeve('bremsen: fem gaa i træk går igennem, resten afvises for_hurtigt', async () => {
    for (let k = 0; k < 12; k++) a2.s.emit('gaa', { vej: [[0.55, 0.55], [0.6, 0.55]] });
    await sov(400);
    const gaar = a2.post.filter((x) => x.h === 'gaar').length;
    const afvist = a2.post.filter((x) => x.h === 'afvist' && x.d.grund === 'for_hurtigt' && x.d.hvad === 'gaa').length;
    assert.ok(gaar >= 5 && gaar <= 6, `gaar ${gaar}`);
    assert.equal(gaar + afvist, 12);
  });

  const a3 = ny();
  await proeve('bremsen følger kontoen: en ny forbindelse giver ikke fulde spande', async () => {
    for (let k = 0; k < 3; k++) a2.s.emit('sig', { tekst: `nummer ${k}` });
    for (let k = 0; k < 3; k++) await a2.vent('sagde');
    await a3.ind(token(A), 'gade', 0.55, 0.55);
    await a3.afvist('sig', { tekst: 'en til' }, 'for_hurtigt');
  });

  await proeve('200 afviste hændelser på 10 s lukker forbindelsen med lukket', async () => {
    const e = ny();
    await e.ind(token(E), 'kaelder', 0.55, 0.55);
    for (let k = 0; k < 250; k++) e.s.emit('noget_andet', k);
    assert.deepEqual(await e.vent('lukket'), { grund: 'for_mange' });
    assert.equal(await e.vent('disconnect'), 'io server disconnect');
  });

  await proeve('en, der kobler fra, går: rummet får gik, og /health tæller ned', async () => {
    await b.spoerg('skift', { rum: 'gade' }, 'rummet');
    assert.equal((await a3.vent('kom')).person.id, 102);
    b.luk();
    assert.deepEqual(await a3.vent('gik'), { id: 102 });
    assert.equal(await online(), 2);
  });

  await proeve('rummene kan hentes over HTTP, og PHP nås på et *.localhost-navn', async () => {
    const r2 = await startRelae({ PHP_BASE: `http://stub.localhost:${STUB}/3d`, RUM_BASE: `http://stub.localhost:${STUB}/rum` });
    const f = ny(r2.port), g = ny(r2.port);
    const r = await f.ind(token({ id: 106, navn: 'ZZf' }), 'gade', 0.55, 0.55);
    assert.equal(r.rum, 'gade');
    assert.ok(rumHentet.some((u) => /^\/rum\/gade\/gulv\.json\?v=\d+$/.test(u)), rumHentet.join(' '));
    assert.ok(rumHentet.some((u) => /^\/rum\/gade\/rum\.json\?v=\d+$/.test(u)), rumHentet.join(' '));
    await g.afvist('ind', { token: token({ id: 107, navn: 'ZZg' }), rum: 'findes_ikke' }, 'rum');
    assert.deepEqual(await f.spoerg('sig', { tekst: 'hej over nettet' }, 'sagde'), { id: 106, tekst: 'hej over nettet' });
  });

  console.log('\nAlle prøver bestået.');
} catch (fejl) {
  fejlet = true;
  console.error('\nFEJL:', fejl);
  for (const r of relaeer) console.error(`--- relæets log (port ${r.port}) ---\n${r.log}`);
} finally {
  for (const k of klienter) k.luk();
  for (const r of relaeer) r.kill();
  stub.close();
  fs.rmSync(RUMMAPPE, { recursive: true, force: true });
  process.exitCode = fejlet ? 1 : 0;
}
