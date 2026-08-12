// Reshapes the Vite output into what Cloudflare Pages expects.
//
// The build leaves static assets in `dist/client/` and the server bundle in
// `dist/server/`. Pages serves one directory and looks inside it for `_worker.js`
// — as a directory when the bundle has more than one module, which ours does
// (`ssr/`, the RSC manifests and the route chunks). Moving the server bundle to
// `dist/client/_worker.js/` is the whole adaptation: Pages excludes that path
// from the static assets it serves, so nothing leaks.
import { cp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = resolve(root, "dist", "client");
const server = resolve(root, "dist", "server");
const target = resolve(client, "_worker.js");

const serverExists = await stat(server).then(() => true, () => false);
if (!serverExists) {
  throw new Error("dist/server is missing — run `vinext build` before this step.");
}

await rm(target, { recursive: true, force: true });
await cp(server, target, { recursive: true });

// `wrangler.json` is the Workers deploy descriptor the Cloudflare Vite plugin
// writes. Pages reads bindings from its own project config, and shipping it
// inside the bundle would only invite the two to disagree.
await rm(resolve(target, "wrangler.json"), { force: true });

const entry = await stat(resolve(target, "index.js")).then(() => true, () => false);
if (!entry) {
  throw new Error("dist/client/_worker.js/index.js is missing — Pages needs it as the entry.");
}

// Without this Pages hands the Worker *every* request, including the build's own
// hashed `/assets/*`, which it then answered with a 404 — the site rendered as
// unstyled HTML with no client bundle at all. Excluding the static paths puts
// Pages back in front of them, which is also what stops each image and script
// from costing a Function invocation.
const staticRoutes = ["/assets/*", "/ranks/*", "/favicon.png", "/og.jpg", "/brand-logo.webp"];
await writeFile(
  resolve(client, "_routes.json"),
  `${JSON.stringify({ version: 1, include: ["/*"], exclude: staticRoutes }, null, 2)}\n`,
);

const modules = await readdir(target);
console.log(`pages bundle ready: dist/client/_worker.js (${modules.length} entries)`);
console.log(`static routes served by Pages, not the Worker: ${staticRoutes.join(" ")}`);
