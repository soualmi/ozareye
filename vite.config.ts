import fs from 'node:fs';
import path from 'node:path';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

// .openai/hosting.json is a local, git-ignored hosting artifact from this
// project's original Cloudflare-hosted scaffold — absent on a fresh clone or
// a non-Cloudflare (e.g. self-hosted VPS) deployment. Read it defensively
// instead of a static import, so this config doesn't hard-fail when it's
// missing (d1/r2 unset just means the Cloudflare D1/R2 bindings below stay
// disabled, which is already correct for a non-Cloudflare deploy) — and
// write the fallback to disk when absent, because @openai/sites-vite-plugin's
// `sites()` plugin (below) separately `cp`s this exact file into dist/.openai
// during `closeBundle`, unconditionally, outside of this config file's own
// import. An in-memory-only fallback here would still leave that copy step
// failing on a fresh clone.
const hostingConfigPath = path.join(process.cwd(), '.openai', 'hosting.json');
function readHostingConfig(): { d1?: string | null; r2?: string | null } {
  try {
    return JSON.parse(fs.readFileSync(hostingConfigPath, 'utf8'));
  } catch {
    const fallback = { project_id: 'self-hosted', d1: null, r2: null };
    fs.mkdirSync(path.dirname(hostingConfigPath), { recursive: true });
    fs.writeFileSync(hostingConfigPath, JSON.stringify(fallback, null, 2) + '\n');
    return fallback;
  }
}

const { d1, r2 } = readHostingConfig();

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
