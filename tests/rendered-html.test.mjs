import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("returns a safe demo leaderboard when the Riot secret is not configured", async () => {
  const response = await render("/api/leaderboard");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  // Shared at the edge on purpose: the payload is public and identical for
  // everyone, so several viewers must not each cost an invocation. It was
  // `private, no-store`, and the endpoint fell over once a handful of browsers
  // had the page open at once.
  assert.match(response.headers.get("cache-control") ?? "", /^public,/);
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=\d+/);

  const payload = await response.json();
  assert.equal(payload.meta.source, "demo");
  assert.equal(payload.meta.cacheTtlSeconds, 60);
  assert.equal(payload.data.region, "LAS");
  assert.equal(payload.data.platform, "LA2");
  assert.equal(payload.data.players.length, 9);
  assert.equal("RIOT_API_KEY" in payload, false);
});

test("server-renders the 20Q Challenge dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="es">/i);
  assert.match(html, /<title>20Q Challenge<\/title>/i);
  assert.match(html, /20Q Challenge/);
  assert.match(html, /Abrir LOS JUEGOS DE GASPI/i);
  assert.match(html, /Top 3 del ranking/);
  assert.match(html, /Resto de la clasificación/);
  assert.match(html, /Ir al ranking/);
  // The first frame is the loading view, built from the real frames.
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="pcard place-1 is-pending"/);
  assert.match(html, /class="srow is-pending"/);
  assert.doesNotMatch(html, /Actualizado|Actualizar/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /is not endorsed by Riot Games/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/i);
});

test("leaves dist/client as a static Pages bundle", async () => {
  // Pages only serves the exported files now. The server bundle is retained in
  // dist/server for local rendering tests, but no Worker or route manifest is
  // allowed into the publish directory.
  const client = new URL("../dist/client/", import.meta.url);
  await access(new URL("index.html", client));
  await access(new URL("privacy.html", client));
  await access(new URL("terms.html", client));
  await access(new URL("ranks/gold.png", client));

  await assert.rejects(access(new URL("_worker.js/index.js", client)));
  await assert.rejects(access(new URL("_routes.json", client)));

  // The stylesheet the HTML asks for has to be one of the files actually
  // shipped — a hash mismatch here is invisible until the page renders bare.
  const html = await (await render("/")).text();
  const stylesheet = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  assert.ok(stylesheet, "the rendered HTML must reference a built stylesheet");
  await access(new URL(`.${stylesheet}`, client));
});

test("ships the finished product assets without starter dependencies", async () => {
  const readSource = async (path) =>
    (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const [page, layout, packageJson] = await Promise.all([
    readSource("../app/page.tsx"),
    readSource("../app/layout.tsx"),
    readSource("../package.json"),
  ]);

  assert.match(page, /\/api\/leaderboard/);
  assert.match(page, /NEXT_PUBLIC_LEADERBOARD_API_ORIGIN/);
  assert.match(layout, /lang="es"/);
  assert.match(layout, /const title = "20Q Challenge"/);
  assert.match(layout, /export const metadata/);
  assert.match(layout, /\/og\.jpg/);
  assert.match(layout, /icon: "\/favicon\.png"/);
  assert.match(layout, /family=Geist\+Mono/);
  assert.match(layout, /family=Instrument\+Sans/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await Promise.all(
    [
      "iron",
      "bronze",
      "silver",
      "gold",
      "platinum",
      "emerald",
      "diamond",
      "master",
      "grandmaster",
      "challenger",
    ].map((tier) => access(new URL(`../public/ranks/${tier}.png`, import.meta.url))),
  );
  await access(new URL("../public/favicon.png", import.meta.url));
  await access(new URL("../public/brand-logo.webp", import.meta.url));
  await access(new URL("../public/og.jpg", import.meta.url));

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
