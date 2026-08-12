# 20Q Challenge

Ranking de SoloQ para el grupo del 20Q Challenge: rango, winrate, KDA, campeones,
racha, dúo habitual y partida en vivo, en LAS/LA2.

Es una app [vinext](https://github.com/cloudflare/vinext) (Next.js sobre Vite) que
corre en Cloudflare Pages, con D1 como almacén y un Worker aparte que dispara los
refrescos programados.

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
| `app/` | Rutas. `page.tsx` es el ranking; `api/leaderboard/route.ts` sirve y refresca el snapshot |
| `worker/index.ts` | Entrada de Cloudflare. Sirve la app y expone los endpoints de cron |
| `lib/riot-client.ts` | Refresco completo del leaderboard. `RIOT_PLAYERS` es el roster |
| `lib/lp-tracker.ts` | Tracker temporal: observa el rango cada minuto para deducir el cambio de PL por partida |
| `lib/lp-reconciliation.ts` | Empareja partidas con observaciones de rango para atribuir el delta de PL |
| `db/` | Esquema Drizzle y stores de D1 |
| `cron-worker/` | Worker aparte que dispara los dos horarios por HTTP |

### Por qué el PL se deduce

Riot no expone el cambio de PL por partida. El tracker guarda una observación de
rango cada minuto y `lp-reconciliation` compara las dos que rodean a una partida.
De ahí que un despliegue nuevo empiece sin histórico de PL: sólo se acumula hacia
adelante.

## Despliegue

La app vive en Cloudflare **Pages**, que no tiene `scheduled`, así que los dos
horarios los dirige `cron-worker` por HTTP:

```
cron-worker (crons)  ──POST /api/cron/lp-tracker──►  Pages   cada minuto
                     ──POST /api/cron/leaderboard─►          minutos 7 y 37
```

Ambos endpoints exigen la cabecera `x-cron-secret`; sin `CRON_SECRET` configurado
responden 404, de modo que un binding ausente cierra la puerta en vez de abrirla.

### Build

```bash
npm run build:pages
```

`vinext build` deja los assets en `dist/client/` y el servidor en `dist/server/`;
`build/pages-bundle.mjs` mueve el segundo a `dist/client/_worker.js/`, que es el
modo avanzado de Pages.

- **Build command:** `npm run build:pages`
- **Output directory:** `dist/client`

### Configuración requerida

En el proyecto de Pages:

- Binding D1 `DB` → `20q-challenge-db`
- Compatibility date: **`2026-07-26`** — la misma que `vite.config.ts` y
  `cron-worker/wrangler.jsonc`. En Pages vive en el dashboard, fuera del repo,
  así que este renglón es su único registro revisable; un test comprueba que los
  tres valores no se separen.
- Flags de compatibilidad: `nodejs_compat`, `nodejs_compat_populate_process_env`.
  El segundo no es opcional: `app/api/leaderboard/route.ts` lee
  `process.env.RIOT_API_KEY`, y sin el flag la app sirve el snapshot de
  demostración para siempre, sin error.
- Secretos: `RIOT_API_KEY`, `CRON_SECRET`

En `cron-worker`: el mismo `CRON_SECRET`.

### Migraciones

```bash
npx wrangler d1 execute 20q-challenge-db --remote --file drizzle/0004_live_game_detail.sql
```

Son aditivas y seguras sobre datos existentes. Genera nuevas con `npm run db:generate`.

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
