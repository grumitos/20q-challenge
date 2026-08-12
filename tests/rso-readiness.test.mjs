import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("rso-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("publishes substantive privacy and terms pages for Riot review", async () => {
  const [privacyResponse, termsResponse] = await Promise.all([
    render("/privacy"),
    render("/terms"),
  ]);

  assert.equal(privacyResponse.status, 200);
  assert.equal(termsResponse.status, 200);

  const [privacy, terms] = await Promise.all([
    privacyResponse.text(),
    termsResponse.text(),
  ]);

  assert.match(privacy, /Política de privacidad/i);
  assert.match(privacy, /partidas personalizadas/i);
  assert.match(privacy, /consentimiento|opt-in/i);
  assert.match(privacy, /eliminación de datos/i);
  assert.match(terms, /Términos del servicio/i);
  assert.match(terms, /partidas personalizadas/i);
  assert.match(terms, /no está respaldado por Riot Games|isn.t endorsed by Riot Games/i);
});

test("publishes a post-logout destination", async () => {
  const response = await render("/signed-out");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sesión de Riot cerrada/i);
});

test("exposes a safe OAuth callback without reflecting authorization secrets", async () => {
  const ready = await render("/api/auth/riot/callback");
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("cache-control"), "no-store");
  assert.equal(ready.headers.get("referrer-policy"), "no-referrer");
  assert.equal(ready.headers.get("x-frame-options"), "DENY");

  const success = await render("/api/auth/riot/callback?code=secret-code&state=verified-state");
  assert.equal(success.status, 200);
  const successHtml = await success.text();
  assert.match(successHtml, /Autorización recibida/i);
  assert.doesNotMatch(successHtml, /secret-code|verified-state/);

  const invalid = await render("/api/auth/riot/callback?code=secret-code");
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /secret-code/);
});
