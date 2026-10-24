# 20Q Challenge

Ranking de SoloQ para el grupo del 20Q Challenge: rango, winrate, KDA, campeones,
racha, dúo habitual y partida en vivo, en LAS/LA2.

Es una app [vinext](https://github.com/cloudflare/vinext) (Next.js sobre Vite):
Cloudflare Pages sirve el frontend estático y un VPS ejecuta el tracker y la API
con Bun y SQLite local.

## Prerequisitos

- Node.js `>=22.13.0`
- Una API key del [Riot Developer Portal](https://developer.riotgames.com/)

## Desarrollo

```bash
npm install
npm run dev
```

Pon la key en `.env.local` (ver `.env.example`); sin ella la app sirve el snapshot
de demostración de `lib/leaderboard.ts` en lugar de datos reales.

## Arquitectura

| Pieza | Qué hace |
|---|---|
| `app/` | Frontend estático; `page.tsx` consulta la API pública del VPS |
| `vps/api-server.ts` | API Bun de lectura para `/api/leaderboard`, sobre SQLite local |
| `vps/tracker-runner.ts` | Proceso oneshot del VPS: tracking temporal y analíticas |
| `lib/riot-client.ts` | Refresco completo del leaderboard. `RIOT_PLAYERS` es el roster |
| `lib/lp-tracker.ts` | Tracker temporal: observa el rango cada minuto para deducir el cambio de PL por partida |
| `lib/lp-reconciliation.ts` | Empareja partidas con observaciones de rango para atribuir el delta de PL |
| `db/` | Esquema/migraciones SQLite compatibles con el adaptador D1 existente |
| `cron-worker/` | Código legado de compatibilidad; no se despliega después del corte |

### Por qué el PL se deduce

Riot no expone el cambio de PL por partida. El tracker guarda una observación de
rango cada minuto y `lp-reconciliation` compara las dos que rodean a una partida.
De ahí que un despliegue nuevo empiece sin histórico de PL: sólo se acumula hacia
adelante.

## Despliegue

Pages conserva la URL pública y solo sirve archivos estáticos. El tráfico de
datos va a `20q-api.yasmiau.com`, que Caddy acepta únicamente desde las redes de
Cloudflare y reenvía al proceso Bun en `127.0.0.1:8200`:

```
Pages estático ──GET /api/leaderboard──►  Caddy ──► Bun API ──► SQLite
systemd timer ───────────────────────────────► Bun tracker ──► Riot + SQLite
```

Cloudflare ya no ejecuta lógica, cron ni lecturas/escrituras D1 para este
proyecto. El frontend mantiene el mismo acceso `20q-challenge.pages.dev`.

### Build

```bash
npm run build:pages
```

`vinext build` deja los assets exportados en `dist/client/`. El servidor se
conserva solo para las pruebas locales; `build/static-pages.mjs` elimina el
bundle Worker y el manifiesto de rutas antes de publicar.

- **Build command:** `npm run build:pages`
- **Output directory:** `dist/client`

### Configuración requerida

En Pages solo se necesita el texto público
`NEXT_PUBLIC_LEADERBOARD_API_ORIGIN=https://20q-api.yasmiau.com`.

La fecha de compatibilidad `2026-07-26` solo se conserva en las
configuraciones legacy de desarrollo y del Worker retirado.

En el VPS, `/etc/20q.env` conserva `RIOT_API_KEY` para el timer. La API
no recibe esa key. La base local vive en
`/var/lib/20q/20q.sqlite` con WAL y migraciones aditivas.

La parte del VPS (`vps/`, `lib/`, `db/`, `drizzle/` y `deploy/`) se publica con
**Deploy VPS** (`mode` = `deploy` o `rollback`, `target_sha` de `main`) por
`app-release` de `vps-platform`. `deploy/units.toml` describe la API, el tracker
y el respaldo nocturno de la base (`deploy/backup.sh`: el histórico de PL no se
puede reconstruir), y `deploy/site.caddy` el sitio. `update.yml` sube cada lunes
las dependencias dentro de su versión mayor y el Bun del VPS.

### Migraciones

```bash
npx wrangler d1 execute 20q-challenge-db --remote --file drizzle/0004_live_game_detail.sql
```

Las migraciones siguen siendo aditivas y sirven para SQLite y D1 durante la
transición. Para conservar el histórico al salir de D1, importa un export SQL
con `bun vps/import-d1-export.ts <export.sql>` antes de arrancar el nuevo
servicio.

## Verificación

```bash
npm run verify
```

Encadena `lint`, `typecheck`, los tests de fuente y el build. Ojo: buena parte de
`tests/ui-regressions.test.mjs` y `tests/scheduled-refresh.test.mjs` afirma sobre
el **texto** del código, no sobre su comportamiento, así que un refactor inocente
puede romperlos.

## Comandos

- `npm run dev` — desarrollo local
- `npm run build:pages` — build para Cloudflare Pages
- `npm run verify` — lint + typecheck + tests + build
- `npm run db:generate` — genera migraciones tras tocar el esquema
