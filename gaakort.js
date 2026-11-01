// Gå-kortet (gulv.json fra rum-pipelinen, tools/3d/PLAN_ISOMETRISK.md afsnit 7) uden three.js:
// afkodningen af gaa og hoejde, de åbne celler, sigtelinjer, nærmeste celle og dørene. Klienten
// bygger videre på den i gulv.js, og relæet (relae3d/) har en kopi af præcis denne fil, som en prøve
// holder byte for byte lig. Rettes den, skal relæets kopi rettes med.
// Punkter er {x, z} i meter; et THREE.Vector3 går også. Celle (i, j) har midten x0 + (i + ½)·celle,
// z0 + (j + ½)·celle og er nummer j·b + i.

const SOEG_MAKS = 3;            // meter: et punkt længere fra gulvet end det har ingen nærmeste celle
export const CM = 0.01;         // gulv.json giver højderne i hele cm

export class Gaakort {
  constructor(d) {
    if (d.version !== 1) throw new Error('gulv.json har en ukendt version');
    this.c = d.celle;
    this.x0 = d.x0;
    this.z0 = d.z0;
    this.b = d.b;
    this.h = d.h;
    const n = d.b * d.h;
    const bits = bytes(d.gaa);
    if (bits.length < Math.ceil(n / 8)) throw new Error('gulv.json: gå-kortet er for kort');
    this.gaa = new Uint8Array(n);
    let antal = 0;
    for (let k = 0; k < n; k++) antal += this.gaa[k] = (bits[k >> 3] >> (k & 7)) & 1;
    if (!antal) throw new Error('gulv.json: rummet har intet gulv');
    this.aabne = new Int32Array(antal);
    for (let k = 0, a = 0; k < n; k++) if (this.gaa[k]) this.aabne[a++] = k;
    // Kun de gåbare cellers højde bruges (de andre kan være borde og vægge); uden feltet er alt i y = 0
    this.cm = new Uint8Array(n);
    if (d.hoejde) {
      const cm = bytes(d.hoejde);
      if (cm.length < n) throw new Error('gulv.json: højderne er for korte');
      for (const k of this.aabne) this.cm[k] = cm[k];
    }
    this.top = this.aabne.reduce((m, k) => Math.max(m, this.cm[k]), 0) * CM;
    this.start = { x: d.start[0], z: d.start[1] };
    this.doere = (d.doere || []).map((x) => ({ til: String(x.til), x: x.x, z: x.z, r: x.r,
                                               ind: { x: x.ind[0], z: x.ind[1] } }));
  }

  aaben(i, j) {
    return i >= 0 && j >= 0 && i < this.b && j < this.h && this.gaa[j * this.b + i] === 1;
  }

  midte(k) {
    const i = k % this.b;
    return { x: this.x0 + (i + 0.5) * this.c, z: this.z0 + ((k - i) / this.b + 0.5) * this.c };
  }

  /** Den gåbare celle nærmest et punkt (højst SOEG_MAKS væk), eller -1. */
  naermeste(x, z) {
    const fi = (x - this.x0) / this.c, fj = (z - this.z0) / this.c;
    const ci = Math.min(this.b - 1, Math.max(0, Math.floor(fi)));
    const cj = Math.min(this.h - 1, Math.max(0, Math.floor(fj)));
    let bedst = -1, d2 = Infinity;
    const maks = Math.ceil(SOEG_MAKS / this.c);
    for (let r = 0; r <= maks; r++) {
      // Cellerne i ring r ligger mindst r - 1 celler fra punktet
      if (bedst >= 0 && (r - 1) * (r - 1) > d2) break;
      for (let j = cj - r; j <= cj + r; j++) {
        const kant = j === cj - r || j === cj + r;
        for (let i = ci - r; i <= ci + r; i += kant ? 1 : 2 * r) {
          if (!this.aaben(i, j)) continue;
          const di = i + 0.5 - fi, dj = j + 0.5 - fj, dd = di * di + dj * dj;
          if (dd < d2) { d2 = dd; bedst = j * this.b + i; }
        }
      }
    }
    return d2 <= maks * maks ? bedst : -1;
  }

  /** Står punktet på gulvet? */
  paaGulvet(p) {
    return this.aaben(Math.floor((p.x - this.x0) / this.c), Math.floor((p.z - this.z0) / this.c));
  }

  /** Gulvets højde i meter under et punkt; uden for gulvet den nærmeste gåbare celles. */
  hoejdeVed(p) {
    if (!this.top) return 0;
    const i = Math.floor((p.x - this.x0) / this.c), j = Math.floor((p.z - this.z0) / this.c);
    const k = this.aaben(i, j) ? j * this.b + i : this.naermeste(p.x, p.z);
    return k < 0 ? 0 : this.cm[k] * CM;
  }

  /** Kan figuren gå i lige linje fra a til b? Alle celler, linjen rører, skal være gåbare. */
  sigt(a, b) {
    const x = (a.x - this.x0) / this.c, z = (a.z - this.z0) / this.c;
    const ex = (b.x - this.x0) / this.c, ez = (b.z - this.z0) / this.c;
    let i = Math.floor(x), j = Math.floor(z);
    const si = Math.sign(ex - x), sj = Math.sign(ez - z);
    const ti = si ? Math.abs(1 / (ex - x)) : Infinity, tj = sj ? Math.abs(1 / (ez - z)) : Infinity;
    let ni = si > 0 ? (i + 1 - x) * ti : si < 0 ? (x - i) * ti : Infinity;
    let nj = sj > 0 ? (j + 1 - z) * tj : sj < 0 ? (z - j) * tj : Infinity;
    if (!this.aaben(i, j)) return false;
    for (let rest = Math.abs(Math.floor(ex) - i) + Math.abs(Math.floor(ez) - j); rest > 0;) {
      if (Math.abs(ni - nj) < 1e-9) {
        // gennem et hjørne: begge celler ved siden af skal også være gåbare
        if (!this.aaben(i + si, j) || !this.aaben(i, j + sj)) return false;
        i += si; j += sj; ni += ti; nj += tj; rest -= 2;
      } else if (ni < nj) {
        i += si; ni += ti; rest--;
      } else {
        j += sj; nj += tj; rest--;
      }
      if (!this.aaben(i, j)) return false;
    }
    return true;
  }

  /** Den dør, hvis cirkel punktet står i, eller null. */
  doerVed(p) {
    return this.doere.find((d) => Math.hypot(p.x - d.x, p.z - d.z) < d.r) || null;
  }
}

/** base64 til bytes; atob findes både i browseren og i Node. */
function bytes(b64) {
  return Uint8Array.from(atob(b64), (t) => t.charCodeAt(0));
}
