# Despliegue (histórico — plataforma ChatGPT Sites)

> **Este documento ya no describe cómo se despliega el proyecto.** El 10 ago 2026
> la app se migró a Cloudflare Pages; el runbook vigente está en el README.
>
> Se conserva porque las secciones §1.bis en adelante siguen siendo la mejor
> descripción escrita del cableado del rediseño —salidas de red, coste en
> consultas D1, resolución del jugador en modo streamer— y esa parte no cambió
> con la migración. Lo que sí caducó es todo lo relativo a Sites: la versión 68,
> el dominio `challenge-20q.grumitos.chatgpt.site` y el empaquetado en `.openai/`.

Runbook para publicar la rama del rediseño. Escrito el 30 jul 2026 contra la
evidencia de runtime de `20q-sites-runtime-evidence-2026-07-30`.

## Estado de partida

La versión 68 de Sites —la que sirve `https://challenge-20q.grumitos.chatgpt.site`—
corresponde al commit `12867f7`, el anterior al inicio del rediseño. Las 20
versiones del historial mapean 1:1 contra commits de `main`, así que el pipeline
venía siguiendo `main` commit a commit y simplemente no ha corrido desde que el
trabajo se movió a la rama.

## 1. La migración 0004: viaja sola, pero hay que confirmar que aterrizó

`drizzle/0004_live_game_detail.sql` añade tres columnas a `tracked_game_sessions`:

```sql
ALTER TABLE tracked_game_sessions ADD champion_id text;
ALTER TABLE tracked_game_sessions ADD champion_name text;
ALTER TABLE tracked_game_sessions ADD participants text;
```

**No hay que aplicarla a mano por adelantado.** `build/sites-vite-plugin.ts`
copia todo `drizzle/` a `dist/.openai/drizzle/` en cada build —su propio
comentario dice «Packages Sites metadata and migrations»—, así que la migración
va dentro del paquete de despliegue. Comprobado en el archivo generado: el
`.tgz` nuevo trae los cinco `.sql`, y su única diferencia de contenido frente al
archivo desplegado de `12867f7` es precisamente `0004_live_game_detail.sql`.

Lo que **no** puedo verificar desde aquí es que Sites las ejecute al desplegar.
No hay migrador dentro del worker (`db/index.ts` sólo devuelve el binding) y los
logs del paquete de evidencia no muestran ningún evento de migración. El
directorio `.openai/` es la convención de Sites y el plugin las deja ahí a
propósito, así que lo más probable es que la plataforma se encargue — pero
trátalo como algo a confirmar, no como algo dado.

**Por qué importa confirmarlo:** `db/lp-tracker-store.ts` nombra esas columnas
**incondicionalmente** en su `INSERT ... ON CONFLICT`, en cada refresco. Si no
existen:

1. el upsert lanza `no such column`;
2. `runTemporalLpTracker` propaga el error;
3. `lib/leaderboard-route.ts` lo captura, marca `refreshFailed` y **sigue
   sirviendo el último snapshot cacheado**;
4. el lector ve «Riot no respondió; se muestra la última actualización
   guardada».

La web no se cae: se congela, y el aviso culpa a Riot. Por eso la línea
`lp_tracker_run` ahora lleva `status` (§5) — con la migración sin aplicar dirá
`failed` y traerá el `no such column` en el campo `error`.

Tras desplegar, confirma con el identificador real de la base (no está en el
paquete de evidencia; sale de tu acceso a Sites/Cloudflare):

```bash
npx wrangler d1 execute <DATABASE> --remote --command "PRAGMA table_info(tracked_game_sessions);"
```

Si `champion_id`, `champion_name` y `participants` no aparecen, aplícala a mano:

```bash
npx wrangler d1 execute <DATABASE> --remote --file drizzle/0004_live_game_detail.sql
```

Es aditiva y sólo usa `ADD COLUMN`, así que es segura sobre datos existentes; el
test `adds the live-game columns the tracker writes on every run` la ejecuta
sobre una base construida con las cuatro anteriores.

## 1.bis Cableado nuevo que producción nunca ha ejecutado

Todo lo de abajo entró con el rediseño. La versión desplegada (`12867f7`) no lo
tiene, así que no hay historial de runtime que lo respalde.

**Salida nueva del worker: `ddragon.leagueoflegends.com`.** `lib/champion-catalog.ts`
descarga `/cdn/{version}/data/en_US/champion.json` para traducir las claves
numéricas de spectator-v5 al id textual. No usa la API key de Riot, se memoiza
por isolate y **sólo se dispara si alguien está en partida**. Va envuelta en
try/catch: si Data Dragon falla, la ranura de "en partida" cae al último partido
terminado. Hasta ahora el worker sólo contactaba `*.api.riotgames.com`; si hay
alguna restricción de egress, este host es nuevo.

**Cuatro consultas D1 extra por petición.** `db/player-enrichment.ts` resuelve
racha, dúo habitual, cambio de puesto y partida en vivo en cada
`GET /api/leaderboard`, porque no viven en el snapshot cacheado. Antes la ruta
hacía una sola lectura de caché. Todas son best-effort: una consulta que falle
degrada ese dato, no la respuesta.

**spectator-v5 parsea más campos.** `lib/riot-tracker-api.ts` ahora extrae
`participants`, el `riotId` de cada uno y el `championId` del jugador. Mismo
endpoint que ya se llamaba, más parseo — y es lo que alimenta las tres columnas
de la migración 0004.

**Resolución del jugador propio en modo streamer.** El ajuste de privacidad
vacía el `puuid` **y** el `riotId` de quien lo activa, así que buscar por `puuid`
perdía justo al jugador del que sabemos con certeza que está en la partida: el
endpoint se consultó con su propio `puuid`. `findTrackedParticipant()` prueba
`puuid`, luego Riot ID, y como último recurso el único participante anónimo del
lobby; si hay dos, se rinde en vez de adivinar. Sin esto la tarjeta «en partida»
salía sin campeón.

**Posiciones en la retícula de diez.** `LastMatchParticipant` lleva ahora un
`role` opcional que sale del `teamPosition` de match-v5, y `orderMatchRoster()`
coloca al equipo del jugador arriba y una posición por columna. **Las partidas en
vivo no llevan rol**: spectator-v5 no reporta posición, y su orden de
participantes tampoco es el del draft — un lobby real volvió con el jungla
tercero y el support último. Ahí la retícula sólo agrupa por `teamId`, que sí es
un dato de Riot.

**Compatibilidad de payloads: no hace falta purgar nada.** Los campos nuevos
(`recentResults`, `habitualDuo`, `liveGame`, `placeDelta`, y ahora
`participants[].role` y `remake`) son opcionales en `lib/leaderboard.ts`, y la
clave de `localStorage` sigue siendo `20q-leaderboard-payload-v1`. Un payload
escrito por el código viejo —en la caché D1 o en el navegador de alguien— sigue
validando con el nuevo. No hay que invalidar caché ni forzar recarga; los roles
aparecerán solos en cuanto el refresco vuelva a normalizar cada partida.

**El polling del navegador no cambió.** `setInterval` cada 60 s ya estaba en
`12867f7`, así que el volumen de peticiones a `/api/leaderboard` se mantiene.

## 2. Secretos

`RIOT_API_KEY` ya está registrada como secreto en Sites (revisión 4, 26 jul
2026). Sites oculta el valor: que la API lo devuelva `null` no significa que
falte. No hay que tocar nada salvo que la clave haya rotado.

El repo nunca la contiene: `.env.local` está en `.gitignore` (`.gitignore:34`).

## 3. Desplegar

Publicar la rama por el camino habitual de Sites. `npm run verify` debe estar en
verde antes: lint, `tsc`, tests de fuente, build y tests de la salida
construida.

## 4. El cron: cómo funciona de verdad

Esto confunde a quien audita los logs, así que queda escrito.

**El `scheduled()` de `worker/index.ts` no se ejecuta en producción.** Los
`triggers.crons` viven en `localBindingConfig` de `vite.config.ts`, que Sites no
aplica al worker desplegado. La evidencia lo confirma: 0 eventos `scheduled` en
6 horas de logs, mientras los refrescos aparecen con `origin: "fetch"` y
`trigger: "GET /api/leaderboard"`.

Quien mantiene la cadencia es un worker **aparte**, `cron-worker/`, con su propio
`wrangler.jsonc` y `"crons": ["* * * * *"]`, que pega a
`/api/leaderboard?source=cron`. La ruta hace el trabajo en el camino de fetch
(`refreshConfiguredPlayers` y `refreshRecent` en `app/api/leaderboard/route.ts`).

Consecuencias prácticas:

- El worker acompañante se despliega por separado, con wrangler, desde
  `cron-worker/`. Si no está desplegado o falla, el marcador sólo se refresca
  cuando alguien tiene la página abierta.
- No hay que "arreglar" la ausencia de eventos `scheduled` en los logs del
  worker principal: nunca los va a haber.
- El `scheduled()` se conserva como camino alternativo por si la plataforma
  llegase a registrar los crons; `tests/scheduled-refresh.test.mjs` lo cubre.

## 5. Verificación posterior

En los logs del worker, cada refresco emite una línea `lp_tracker_run`. Desde
esta entrega lleva `status`, que es lo que permite distinguir un fallo real de
una caída de Riot:

| `status` | Significa |
| --- | --- |
| `completed` | Refresco normal. |
| `bootstrapped` | Primera corrida: sembró `player_sync_state`. |
| `skipped:no_cached_snapshot` | Aún no hay snapshot que refrescar. |
| `skipped:lease_unavailable` | Otra corrida tenía el lease. Constante = lease atascado. |
| `failed` | Lanzó. El campo `error` trae el motivo — **aquí aparecería la migración sin aplicar**. |

Presupuesto de Riot: `requestsUsed` sale de `RIOT_PLAYERS.length * 5` (45 con 9
jugadores). Que las corridas terminen con `requestsRemaining` entre 4 y 8 es lo
esperado, no un síntoma: el reparto está diseñado para saturarlo dando dos
detalles de partida por jugador antes de gastar en un tercero, y
`tests/lp-tracker-integration.test.mjs` fija ese reparto. El presupuesto escala
con el tamaño del roster, así que añadir un décimo jugador lo sube a 50 solo.

## 6. Ajustes de plataforma que hay que cambiar

Estos no son código: viven en Sites y sólo los puede tocar quien publica. Salen
de contrastar el paquete de evidencia del 30 jul 2026 contra el código nuevo.

**La descripción del sitio está obsoleta.** `site-metadata.json` la tiene como:

> «Clasificación privada de SoloQ 2026 entre amigos, con progreso hacia Oro.»

La meta ya no es fija. `challengeGoalForLeader()` la calcula: devuelve `GOLD`
hasta que el líder llega a Oro y `PLATINUM` a partir de ahí. **El líder ya es Oro
III**, así que la meta vigente es Platino, y la tarjeta de Meta apunta al rango
real del jugador objetivo (Platino IV, 20 PL). Sugerencia:

> «Clasificación de SoloQ 2026 entre amigos: rango, winrate, KDA, campeones y
> última partida.»

Sin meta fija en el texto, porque el texto no puede seguir a un valor calculado.
La `description` de la app (`app/layout.tsx`) ya está redactada así y no
menciona ningún rango — sólo hay que alinear la de Sites.

**`accessMode: "public"`** mientras esa misma descripción dice «privada».
Cualquiera con el enlace ve los Riot ID de los nueve jugadores. O se restringe el
acceso o se quita la palabra. Decisión del dueño, no del despliegue.

## 7. Dónde vive todo lo que no está en el repo

### Canal de publicación

El remoto `sites` **es** el despliegue — su URL lleva el mismo project id que
`.openai/hosting.json` y `site-metadata.json`:

```
sites  https://git.chatgpt-team.site/d6faa60b-0308-437c-8e9d-94506d639e4e/appgprj_6a55364e65648191aaa4a19f259d92e9.git
```

Sites construye desde un push, así que **sólo viajan commits**; un árbol de
trabajo sin commitear es impublicable, tenga o no acceso al disco quien publique.

Estado del ref, comprobado el 1 ago 2026 (último fetch: 30 jul 2026, 01:25):

```
sites/main = 12867f7        HEAD = <esta rama>, 13 commits por delante
git merge-base --is-ancestor sites/main HEAD  ->  sí
```

Es un **fast-forward limpio**: `git push sites HEAD:main` no rebotaría. Una
versión anterior de este runbook decía que el ref estaba en `83254b9` y avisaba
de un push no-fast-forward; eso ya no es cierto y quedaba como aviso engañoso.

> Aun así, **`git fetch sites` antes de nada**. El ref local lleva dos días sin
> refrescarse y sólo refleja lo que se sabía entonces; si alguien empujó desde
> el 30 de julio, el push rebotaría — y forzarlo revertiría producción a un
> commit viejo.

### Repos y worktrees en disco

| Ruta | Qué es |
| --- | --- |
| `D:\Dev\20q-challenge-design-audit-2026-07-26` | Repo principal. Tiene `audit/frontend-2026-07-28` en `83254b9`. |
| `└─ .claude\worktrees\current-view-browser-0f5d60` | **Worktree de este trabajo.** Rama `claude/current-view-browser-0f5d60`, 13 commits por delante de producción, 0 por detrás. |
| `D:\Dev\20q-challenge-current-2026-07-30` | Repo hermano; su `main` es el remoto local `current` (`12867f7`). |

La rama no se ha empujado nunca a ningún remoto.

### Paquetes de auditoría externos

Ambos en `C:\Users\nosky\Documents\Codex\2026-07-26\20q-challenge-recovery\artifacts\`:

| Archivo | Contenido |
| --- | --- |
| `20q-sites-runtime-evidence-2026-07-30.zip` (+ carpeta homónima) | Metadatos de Sites, historial de versiones, entorno, dominios y 100 eventos de log saneados. **Sin código.** |
| `20q-worker-audit-v68-2026-07-30\` | **Sí trae código**: `source/` con el árbol completo del commit desplegado, `deployed-artifact/dist/` con el build empaquetado, y `evidence/` con `deployment-archive-12867f7.tgz`. |
| `20q-<sha>.tgz` | Archivos de despliegue por commit. Los nueve históricos van de `15bb330` a `12867f7`; **el de esta entrega lleva el sha de HEAD** y a su lado está su `.sha256`. Cada uno es un tar de `dist/`. |

El paquete nuevo trae 52 archivos frente a los 51 de `12867f7`, y esa diferencia
es exactamente una: `dist/.openai/drizzle/0004_live_game_detail.sql`. Todo lo
demás conserva los mismos nombres una vez normalizados los hashes de contenido
que Vite añade a los assets compilados.

`dist/` no incluye documentación, así que un commit que sólo toque este archivo
no cambia el contenido del paquete — pero sí su nombre. Para regenerarlo desde
el commit que vayas a desplegar:

```bash
npm run build && tar czf 20q-$(git rev-parse --short HEAD).tgz --force-local dist
sha256sum 20q-$(git rev-parse --short HEAD).tgz > 20q-$(git rev-parse --short HEAD).tgz.sha256
```

Verifiqué el bundle de la v68 contra nuestro repo: `app/page.tsx`,
`lib/lp-tracker.ts`, `worker/index.ts`, `cron-worker/wrangler.jsonc`,
`db/lp-tracker-store.ts` y `vite.config.ts` **coinciden byte a byte con
`12867f7`**. La procedencia de producción es sólida y esta rama desciende en
línea recta de lo que está vivo.

### Configuración de Cloudflare que sí está en el repo

| Ruta | Para qué |
| --- | --- |
| `.openai/hosting.json` | Declara los bindings de Sites: `d1: "DB"`, `r2: null`. |
| `vite.config.ts` | `localBindingConfig`: entrada del worker, flags de compatibilidad, D1/R2 y unos `triggers.crons` **que Sites no aplica** (§4). |
| `cron-worker/wrangler.jsonc` | El worker acompañante que sí tiene cron real. Se despliega aparte. |
| `worker/index.ts` | Entrada `fetch` + `scheduled` del worker principal. |
| `drizzle/*.sql` | Migraciones. La 0004 es la que hay que aplicar (§1). |

### Fuera de control de versiones (no se despliegan)

| Ruta | Nota |
| --- | --- |
| `.env.local` | La Riot API key de desarrollo. Ignorado por `.gitignore:34` (`.env*`). Nunca se commitea. |
| `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` | D1 local de miniflare, sembrada con datos reales para desarrollo. Ignorado por `.gitignore:45`. No tiene relación con la D1 de producción. |
| `dist/` | Salida de build. Ignorado por `.gitignore:43`. |

## Sobre el paquete de evidencia

Lo revisé archivo por archivo contra el código nuevo. **No hay
incompatibilidades que arreglar dentro del zip**, y lo que registra sigue siendo
correcto:

| Archivo | Veredicto |
| --- | --- |
| `environment-metadata.json` | Compatible. El código sólo exige `RIOT_API_KEY` más los bindings `DB`, `ASSETS` e `IMAGES`; el rediseño no añadió ninguna variable. |
| `custom-domains.json` | Vacío, sin efecto. |
| `production-versions.json` | Registro histórico de despliegues. |
| `worker-logs-sanitized.json`, `worker-runtime-summary.json`, `latest-log-query.json` | Muestras de runtime ya capturadas. |
| `site-metadata.json` | Refleja fielmente el estado de Sites; lo que hay que cambiar es ese estado, no el archivo (§6). |
| `README.md` | Su única pregunta abierta —por qué no aparecen eventos `scheduled`— queda resuelta en §4: nunca los habrá en ese worker. |

No edité ninguno. Son **capturas de estado de la plataforma**: reescribirlas no
cambia nada en producción y falsearía el registro de la auditoría. Los cambios
que sí hacen falta están en §1 (migración) y §6 (ajustes de Sites).

Nota de empaquetado: `file-manifest.sha256` está en CRLF, así que `sha256sum -c`
falla hasta pasarle `tr -d '\r'`. Con eso, los ocho hashes verifican.
