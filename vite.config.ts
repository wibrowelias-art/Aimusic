import { createServer, type Connect, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

type Backend = typeof import('./server/plugin');

/**
 * Mounts the Style Lab backend (server/plugin.ts) on /api/style. The module is loaded
 * through Vite itself, so this config file has no local imports and the key handling
 * stays on the Node side.
 */
function styleLabApi(): Plugin {
  const mount = (middlewares: Connect.Server, root: string, load: () => Promise<Backend>): void => {
    middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/style/')) return next();
      void (async () => {
        try {
          const backend = await load();
          await backend.createStyleLabHandler(root)(req, res, next);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: { message: String(err), code: 'server', suggestion: null } }));
        }
      })();
    });
  };
  return {
    name: 'style-lab-api',
    configureServer(server) {
      mount(server.middlewares, server.config.root, () => server.ssrLoadModule('/server/plugin.ts') as Promise<Backend>);
    },
    configurePreviewServer(server) {
      let loaded: Promise<Backend> | null = null;
      mount(server.middlewares, server.config.root, () => {
        loaded ??= (async () => {
          const loader = await createServer({
            configFile: false,
            root: server.config.root,
            server: { middlewareMode: true },
            appType: 'custom',
            logLevel: 'error',
          });
          return (await loader.ssrLoadModule('/server/plugin.ts')) as Backend;
        })();
        return loaded;
      });
    },
  };
}

export default defineConfig({
  plugins: [styleLabApi()],
  server: { host: true, port: 5173 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
