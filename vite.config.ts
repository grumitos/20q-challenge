import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

/**
 * Local development only. Production bindings live in the Cloudflare Pages
 * project, and the compatibility date and flags are set there too — this shape
 * exists so `npm run dev` has a D1 to talk to and the cron handlers can be
 * exercised by hand.
 *
 * The crons below do fire against `.env.local`'s real Riot key while the dev
 * server is up, which is worth remembering before leaving it running.
 */
const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_date: "2026-07-26",
  compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  triggers: { crons: ["* * * * *", "7,37 * * * *"] },
  d1_databases: [
    {
      binding: "DB",
      database_name: "20q-challenge-db",
      database_id: "49b203b4-5473-4177-9126-0bc2e2c16c8f",
    },
  ],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
