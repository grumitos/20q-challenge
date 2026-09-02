import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const client = resolve(import.meta.dirname, "..", "dist", "client");

// Static Pages must not receive a bundled Worker. `vinext` still emits the
// server bundle during its build because the repository keeps the legacy API
// routes for local compatibility; only the exported client directory is
// published.
await rm(resolve(client, "_worker.js"), { recursive: true, force: true });
await rm(resolve(client, "_routes.json"), { force: true });

await stat(resolve(client, "index.html"));
console.log("static Pages bundle ready: dist/client/index.html");
