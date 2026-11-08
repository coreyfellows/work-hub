import { join } from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { config as hubConfig, repoRoot } from './server/config.ts';
import { genPlugins } from './scripts/gen-plugins.ts';

/**
 * Bundles the active plugins' web code: writes web/src/plugins.generated.ts (server/plugins/generateWebModule.ts, the
 * same resolver the server loads plugins with) when the config is read, at every build start and when plugins.json
 * changes in dev; points `work-hub/plugin-api/web` at plugin-api/web.ts for local plugins; and lets the dev server
 * read local plugin folders. A new local folder needs a dev server restart (fs.allow is fixed at startup).
 */
function workHubPlugins(): Plugin {
  const generate = genPlugins;
  return {
    name: 'work-hub-plugins',
    config() {
      const generated = generate();
      const local = generated.plugins.filter((p) => !p.official);
      return {
        // Active plugins' extra pages (`webEntries`), e.g. the auth plugin's sign-in page: dist/plugin-entries/<name>.html.
        build: { rollupOptions: { input: Object.fromEntries(generated.entries.map((e) => [`entry-${e.name}`, e.html])) } },
        resolve: { alias: { 'work-hub/plugin-api/web': join(repoRoot, 'plugin-api', 'web.ts') } },
        // Setting `allow` replaces Vite's default (the workspace root), so the repo goes in explicitly.
        server: { fs: { allow: [repoRoot, ...local.map((p) => p.dir)] } },
        // Pre-bundle local plugins' npm imports too (the default entries are just the HTML pages).
        ...(local.length ? { optimizeDeps: { entries: ['**/*.html', ...local.map((p) => p.web)] } } : {}),
      };
    },
    buildStart() {
      generate();
    },
    configureServer(server) {
      server.watcher.add(hubConfig.pluginsFile);
      server.watcher.on('change', (file) => {
        if (file === hubConfig.pluginsFile) generate();
      });
    },
  };
}

// One id per build: baked into the bundle and written to dist/build.txt, which the server sends on the SSE stream
// so tabs still running an older build reload after a deploy (web/src/api.ts, server/lib/buildId.ts).
const buildId = String(Date.now());

const apiPort = Number(process.env.WORK_HUB_PORT ?? 4848);
const webPort = Number(process.env.WORK_HUB_WEB_PORT ?? 4849);
const host = process.env.WORK_HUB_HOSTNAME?.trim() || undefined;
const port = Number(process.env.WORK_HUB_PUBLIC_PORT ?? 443);
const publicHost = host && (port === 443 ? host : `${host}:${port}`);

// Dev only. Localhost mode (no hostname): the API accepts the Vite port's own Host and Origin, so they pass as they are.
// With a hostname the API answers solely to that name, so present requests as coming from it.
const toApi: ProxyOptions = publicHost
  ? {
      target: `http://127.0.0.1:${apiPort}`,
      headers: { host: publicHost },
      ws: true,
      configure: (proxy) => {
        proxy.on('proxyReq', (req) => {
          if (req.getHeader('origin')) req.setHeader('origin', `https://${publicHost}`);
        });
        proxy.on('proxyReqWs', (req) => {
          if (req.getHeader('origin')) req.setHeader('origin', `https://${publicHost}`);
        });
      },
    }
  : { target: `http://127.0.0.1:${apiPort}`, ws: true };

// The auth plugin's sign-in page, when it's on: GET /login is the Vite-served page, the sign-in POSTs go to the API.
const loginPage = genPlugins().entries.some((e) => e.name === 'login');

export default defineConfig(({ command }) => ({
  root: 'web',
  define: { __WH_BUILD__: JSON.stringify(command === 'build' ? buildId : 'dev') },
  plugins: [
    workHubPlugins(),
    react(),
    {
      name: 'work-hub-build-id',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build.txt', source: buildId });
      },
    },
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: 'web/index.html' } },
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': toApi,
      ...(loginPage
        ? { '/login': { ...toApi, bypass: (req: { method?: string; url?: string }) => (req.method === 'GET' ? '/plugin-entries/login.html' : undefined) } }
        : {}),
    },
  },
}));
