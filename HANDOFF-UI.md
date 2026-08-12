# Handoff de UI — registro histórico (26 jul 2026)

> **Estado: cerrado.** Las tareas 1–9 de abajo están todas aplicadas. El
> documento se conserva como registro de por qué se tomó cada decisión, **no**
> como lista de trabajo pendiente.
>
> **Buena parte de sus reglas quedó superada** por el rediseño sobre el frame 1b
> de la auditoría de Claude Design (30 jul 2026), que reconstruyó `page.tsx` y
> `globals.css` por completo. Antes de guiarte por cualquier párrafo de este
> archivo, contrasta con `tests/ui-regressions.test.mjs`: **la suite es el
> contrato vivo; este documento no.**

## Reglas

1. `npm run verify` debe pasar tras cada cambio: lint, tsc, tests de fuente,
   build y tests de salida construida. No fijes aquí un conteo: la suite crece
   con cada regresión cubierta.
2. Los tests de `tests/ui-regressions.test.mjs` comparan el *texto fuente* de
   `page.tsx` y `globals.css` con expresiones regulares. Un cambio inocuo de
   formato puede romperlos. Si un test falla, lee su nombre antes de tocarlo:
   varios codifican decisiones deliberadas (ver §0).
3. No cambies anchos de columna, tamaños de fuente, colores ni `grid-template-*`
   sin una petición posterior del usuario.

---

## §0. Lo que NO debes "arreglar"

Estas cosas parecen defectos y son intencionales. Están protegidas por tests.

**El podio va 1-2-3 de izquierda a derecha, no 2-1-3.** El orden del DOM es
1-2-3; un podio clásico centrado pondría el orden de foco en desacuerdo con el
orden de lectura (WCAG 2.4.3). La jerarquía del #1 se resuelve con peso visual
—cresta dorada, cifra de PL mayor, tinte de medalla— y ya está aplicada.

**`data-label` en las celdas de fila.** Ya no es decorativo: por debajo de 960px
`.row-grid [data-label]::before` lo pinta como rótulo de cada cifra apilada, que
es como se resolvió el hallazgo 11 de la auditoría (cifras sin nombre en móvil).
**No los borres.**

**Las animaciones usan `backwards`, nunca `both`.** Un relleno hacia adelante
sigue aplicando el último keyframe mientras el elemento viva y gana sobre las
declaraciones del autor, así que deja muertos el hover y el estado atenuado de
respawn. Vale igual para `element.animate()` en el FLIP del ranking.

### Superado por el rediseño de frame 1b (30 jul 2026)

- **«El navegador no refresca solo».** Ya no: la página hace polling cada 60 s
  (`LEADERBOARD_REFRESH_MS`) y el test `keeps the leaderboard synchronized with
  the one-minute cloud cadence` exige `window.setInterval`. El test que lo
  prohibía se retiró.
- **`.row-stats` con `display: contents`.** El envoltorio ya no existe; la fila
  se compone con `grid-template-areas` en móvil.
- **Orden de columnas de 8 celdas y anchos de retrato 36/28px con pista de
  96px.** La rejilla actual es de 7 columnas y sus anchos están fijados en
  `tests/ui-regressions.test.mjs`.

---

## 1. Estado de error de red

**Problema.** En `app/page.tsx`, dentro de `loadLeaderboard`, el `catch` descarta
todo lo que no sea `AbortError` y no hace nada. Si la primera carga falla y no
hay caché en `localStorage`, la página se queda en esqueleto indefinidamente
(`.leaderboard-panel.is-loading { min-height: 700px }`) sin ningún mensaje.

**Solución.** Reutiliza `.status-notice`, que ya existe y ya está estilizado.

En el componente `Home`, junto a los demás `useState`:

```tsx
const [loadError, setLoadError] = useState(false);
```

En `loadLeaderboard`, sustituye el `catch` actual por:

```tsx
} catch (error) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  if (active && !hasCachedData.current) setLoadError(true);
}
```

Y en el `try` que precede al `setPayload`, limpia el estado en el camino feliz:
añade `setLoadError(false);` justo después de `setHasLiveData(true);`.

En el JSX, sustituye la línea del aviso por estas dos:

```tsx
{loadError ? <p className="status-notice" role="alert">No se pudo contactar con Riot. Reintenta recargando la página.</p> : null}
{payload.meta.notice ? <p className="status-notice" role="status">{payload.meta.notice}</p> : null}
```

`role="alert"` (no `status`) porque es una condición de fallo.

---

## 2. Exponer `meta.isStale`

**Problema.** `lib/leaderboard-route.ts:44` calcula `isStale` y
`parseLeaderboardPayload` lo valida, pero la UI solo renderiza `meta.notice`.
Los datos rancios se presentan como frescos.

**Solución.** En `.panel-footnote`, envuelve la marca de tiempo cuando esté
rancia. Sustituye el `<span>` de actualización por:

```tsx
<span>
  Rango y récord: Riot League · actualización {formattedUpdate(payload.data.fetchedAt)}
  {payload.meta.isStale ? " (sin refrescar)" : ""} · caché de 1 min
</span>
```

No añadas CSS: `.panel-footnote` ya usa `var(--muted)` y el paréntesis basta.
El test `explains PL evidence and historical coverage…` exige que siga
apareciendo la subcadena `caché de 1 min` — la conserva.

---

## 3. No mostrar datos demo como si fueran reales

**Problema.** `initialPayload` usa `createDemoSnapshot(new Date("2026-01-01"))`.
Mientras `hasLiveData` es `false`, la píldora «Meta» de la cabecera pinta el
rango demo a opacidad plena, y `.panel-footnote` muestra `01 ene` como fecha de
actualización. Son datos inventados presentados como ciertos.

**Solución.** Sustituye los dos valores derivados en `Home`:

```tsx
const mamimuSummary = hasLiveData ? (mamimu ? `${rankLabel(mamimu)} ${mamimu.leaguePoints}PL` : "Sin rango 0PL") : "—";
```

Y en `.panel-footnote`, envuelve la marca de tiempo:

```tsx
{hasLiveData ? `actualización ${formattedUpdate(payload.data.fetchedAt)}` : "cargando"}
```

Manteniendo el resto de la cadena intacta (ver el test citado en la tarea 2).

---

## 4. Destino del enlace de salto tapado por la cabecera

**Problema.** `.skip-link` apunta a `#clasificacion`. La cabecera es `sticky` y
mide **75px** en escritorio / 65px en móvil; `#clasificacion` tiene
`scroll-margin-top: 0`. Con `scroll-behavior: smooth`, el destino queda debajo
de la cabecera.

**Solución.** En `app/globals.css`, junto a la regla `.leaderboard-panel`:

```css
#clasificacion { scroll-margin-top: 88px; }
```

---

## 5. Idioma del descargo de Riot

**Problema.** El segundo `<span>` del `<footer>` está en inglés dentro de
`<html lang="es">`. Un lector de pantalla en español lo pronuncia como español.

**Solución.** Añade `lang="en"` a ese `<span>` en `app/page.tsx`:

```tsx
<span lang="en">20Q Challenge is not endorsed by Riot Games…</span>
```

No toques el texto: el test `explains PL evidence…` no lo cubre, pero es texto
legal de Riot y debe permanecer literal.

---

## 6. Área táctil de los enlaces del footer

**Problema.** «Privacidad» y «Términos» miden **45×11 px** y **39×11 px**.
WCAG 2.2 AA 2.5.8 exige 24×24 px mínimo. (Los de `.legal-nav` ya se corrigieron.)

**Solución.** En `app/globals.css`, junto a la regla `footer a` existente:

```css
footer a { display: inline-block; padding-block: 7px; }
```

`inline-block` + `padding-block` lleva la altura de 11px a 25px sin alterar el
flujo del texto ni el interlineado del párrafo.

---

## 7. Nombre accesible de las celdas Winrate y KDA

**Problema.** `.table-heading` es `aria-hidden="true"` y las celdas no tienen
nombre propio, así que un lector de pantalla anuncia `"50.4% 176V · 173D"` y
`"2.2 KDA"` sin contexto semántico adicional. En móvil la cabecera
ni siquiera existe (`display: none`).

**Solución.** Los atributos `data-label` ya contienen exactamente el texto
necesario.

> ⚠️ Las cadenas `className="row-winrate" data-label="Winrate"` y
> `className="row-kda" data-label="KDA"` aparecen **dos veces** en `page.tsx`:
> una en `SkeletonRow` (~línea 514) y otra en `LeaderboardRow` (~línea 620).
> Edita **solo las de `LeaderboardRow`**. El esqueleto es `aria-hidden` y no
> debe llevar `aria-label`.

En `LeaderboardRow`, añade `aria-label` a las dos celdas:

```tsx
<span className="row-winrate" data-label="Winrate" role="group" aria-label={`Winrate: ${player.riotIdFound ? `${player.winRate.toFixed(1)}%, ${player.wins} victorias, ${player.losses} derrotas` : "sin estadísticas"}`}>
```

```tsx
<span className="row-kda" data-label="KDA" role="group" aria-label={`KDA: ${player.riotIdFound ? `${player.analytics.kda.toFixed(1)} sobre ${player.analytics.games} partidas analizadas` : "sin historial"}`}>
```

El contenido visual debe mantener el valor seguido de la etiqueta fija `KDA`;
el `aria-label` conserva además el número de partidas analizadas. `role="group"`
es necesario para que ese nombre se anuncie en un `<span>`.

---

## 8. Estructura de encabezados

**Problema.** El único encabezado del documento es un `<h1 class="sr-only">`.
No hay `h2`, así que un lector de pantalla no puede saltar entre el podio y la
tabla.

**Solución.** En `app/page.tsx`, añade un encabezado oculto a cada sección.
La `<section className="podium">` ya tiene `aria-label="Top 3 del ranking"`;
cámbialo por un encabezado real:

```tsx
<section className="podium" aria-labelledby="podio-title">
  <h2 className="sr-only" id="podio-title">Top 3 del ranking</h2>
```

Y antes de `<ol className="leaderboard-list" start={4}>`:

```tsx
<h2 className="sr-only" id="resto-title">Resto de la clasificación</h2>
```

añadiendo `aria-labelledby="resto-title"` al `<ol>`.

---

## 9. Tooltips de campeón inalcanzables en táctil

**Problema.** `.champion-tooltip` depende de `:hover` / `:focus-visible`. Un
toque no dispara `:focus-visible` (verificado: `matches(':focus-visible')` es
`false` tras enfocar por toque). En móvil, el winrate por campeón es
inalcanzable para un usuario vidente. Además, los `.champion` son
`<span tabIndex={0}>`: con 7 jugadores son **28 de las 46 paradas de tabulación**
de la página; con 20 jugadores serían ~80.

**Decisión ya tomada** (no la reabras): los iconos dejan de ser focusables uno a
uno y el dato pasa a estar siempre disponible como texto accesible.

**Solución.**

1. En `Champions` (`app/page.tsx`), quita `tabIndex={0}` del `<span className="champion">`.
   El `aria-label={details}` ya presente se conserva: el lector de pantalla sigue
   anunciando «Campeón: N partidas, X% de winrate».
2. Añade `role="listitem"` a cada `.champion` y cambia el contenedor
   `role="group"` por `role="list"`, para que el grupo se recorra como lista.
3. El tooltip visual se mantiene solo como mejora de puntero. En
   `app/globals.css`, sustituye el selector del tooltip
   `.champion:is(:hover, :focus-visible) .champion-tooltip` por
   `.champion:hover .champion-tooltip` y elimina la regla
   `.champion:focus-visible { outline: … }`.

El test `renders four best champions in podium and list…` exige que
`className="champion-tooltip"` siga existiendo en el fuente — se conserva.

---

---

## Decisión resuelta — splash del podio

El usuario confirmó que la imagen vertical de carga debe seguir siendo la
referencia para encuadrar el splash completo. La tarjeta pinta ahora un
`<img crossorigin="anonymous">` dentro de `.podium-splash-frame`, por lo que el
canvas y la capa visible comparten la misma variante de caché.

La coincidencia por luma calcula el foco horizontal. `PodiumCard` intenta
centrarlo y limita el desplazamiento entre `frameWidth - imageWidth` y `0`, de
modo que ningún foco lateral puede dejar un borde vacío. Un `ResizeObserver`
recalcula esa posición cuando cambia el ancho de la tarjeta. Conserva este
clamp si se toca el tratamiento visual; centrar con un `translateX` porcentual
sin límites vuelve a descubrir fondo en campeones con foco lateral.

---

## Verificación final

```bash
npm run lint && npx tsc --noEmit && npm run test:source && npm test
```

Comprobación visual mínima, con `npm run dev` en `http://localhost:3000`:

- A 1440px: las etiquetas de rango de todas las filas empiezan en la misma `x`
  sin importar el tier. Ninguna columna desborda su pista.
- A 375px, medido desde el borde izquierdo del `.app-shell`:
  - puesto, winrate y rol alinean en `17px`; avatar en `55px`; nick en `109px`.
    Los mismos valores valen para las tarjetas del podio.
  - rango, KDA y campeones alinean su borde derecho en `342px`.
- Desconecta la red y recarga: debe aparecer el aviso de la tarea 1, no un
  esqueleto perpetuo.
