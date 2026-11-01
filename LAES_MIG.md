# Swaps 3D: relæet

Relæet lader folk i 3D-verdenen se hinanden: hvem der er i rummet, hvor de går, hvad de siger, og
hvem der skriver. Det har ingen database. Hvem man er, står i et token fra 3D's PHP, og beskederne
filtreres og gemmes af PHP (`3d/besked.php`). Det er en særskilt tjeneste: det rører hverken chattens
relæ (swaps-relay-eu), dens nøgler eller dens database.

Hændelserne, tokenet og kaldet til `besked.php` står i `tools/3d/PLAN_ISOMETRISK.md` afsnit 18 i
swaps3d-grenen.

## Filerne

| Fil | Hvad |
|---|---|
| `index.js` | tokenet, rummene, hændelserne, bremsen og `/health` |
| `rum.js` | henter rummenes `gulv.json` og `rum.json` fra en mappe eller over HTTPS |
| `gaakort.js` | gå-kortet: en kopi af `3d/js/gaakort.js` (se nedenfor) |
| `vej.js` | vejene: længde og hvor langt man er nået |
| `net.js` | kaldene til PHP og 3D-siden |
| `test/proeve.js` | prøverne (`npm test`) |
| `lokalt.sh` | starter relæet i testmiljøet |
| `render.yaml` | tjenesten på Render |

`gaakort.js` rettes aldrig her. Rettes `3d/js/gaakort.js`, kopieres den hertil igen, og `npm test`
siger til, hvis kopien ikke er ens.

## Miljøet

| Variabel | På Render | Lokalt (`lokalt.sh`) |
|---|---|---|
| `S3D_RELAE_HEMMELIGHED` | ejeren skriver den selv (se nedenfor) | læses fra `C:\xampp\swaps3d_privat\3d_config.php` |
| `PHP_BASE` | `https://www.swaps.dk/3d` | `http://swaps3d.localhost/swaps3d/3d` |
| `RUM_BASE` | `https://www.swaps.dk/3d/filer/rum` | `../3d/filer/rum` |
| `CORS_ORIGIN` | `https://www.swaps.dk,https://swaps.dk` | `http://swaps3d.localhost` |
| `PORT` | Render sætter den | `3013` |

Relæet starter ikke uden dem alle, og hemmeligheden skal have mindst 40 tegn.

## Lokalt

```bash
npm install
npm test
bash lokalt.sh
```

`npm test` starter sit eget relæ på en tilfældig port med en stub af PHP og egne prøverum og rører
hverken testmiljøets database eller swaps.dk. `lokalt.sh` kører relæet på port 3013 mod testmiljøets
PHP, og `S3D_RELAE_URL` i den lokale `3d_config.php` er `http://localhost:3013`.

## På Render

1. Et nyt **privat** GitHub-arkiv, `swaps-relae3d`, med denne mappe på grenen `main`.
2. På render.com: **New → Blueprint**, vælg arkivet. Render læser `render.yaml`: tjenesten
   `swaps-relae3d` i Frankfurt på den gratis plan.
3. Render spørger efter `S3D_RELAE_HEMMELIGHED`. Den skal være præcis den samme som
   `S3D_RELAE_HEMMELIGHED` i `httpd.private/3d_config.php` på swaps.dk. Ejeren kopierer den selv, og den
   skrives aldrig i git, i chatten eller i en besked. Skiftes den, skal den skiftes begge steder.
4. Når Render har bygget, svarer `https://swaps-relae3d.onrender.com/health` (eller den adresse,
   Render giver) med `{"ok":true,"online":0,"commit":"<de første 7 tegn af commit'et>"}`.
5. `S3D_RELAE_URL` i `httpd.private/3d_config.php` sættes til den adresse, uden `/` til sidst. Først
   derefter lægges 3D-siden op med klienten, der forbinder.

Render bygger igen ved hver push til `main`. Den gratis plan sover efter 15 minutter uden trafik, og
den første, der kommer ind bagefter, venter op til et minut.
