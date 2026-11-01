// Vejene, som klienterne går dem: punkter {x, z} i meter med startpunktet først. Mellem klient og
// relæ sendes de som [[x, z], ...] (tools/3d/PLAN_ISOMETRISK.md afsnit 18).

/** {x, z} af et punkt [x, z] fra klienten, eller null. */
export function punkt(v) {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? { x: v[0], z: v[1] } : null;
}

/** Vejen, som den sendes til klienterne. */
export const tilNet = (vej) => vej.map((p) => [p.x, p.z]);

/** Vejens længde i meter. */
export function laengde(vej) {
  let m = 0;
  for (let k = 1; k < vej.length; k++) m += Math.hypot(vej[k].x - vej[k - 1].x, vej[k].z - vej[k - 1].z);
  return m;
}

/** Hvor man er, så mange meter henne ad vejen; vejens ende, når den er gået. */
export function henne(vej, meter) {
  for (let k = 1; k < vej.length; k++) {
    const a = vej[k - 1], b = vej[k];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (meter < l) return { x: a.x + (b.x - a.x) * meter / l, z: a.z + (b.z - a.z) * meter / l };
    meter -= l;
  }
  return vej[vej.length - 1];
}
