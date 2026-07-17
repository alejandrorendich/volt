// @ts-check
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { builtinModules } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

const entryPoint = resolve(__dirname, 'src/extension/activate.ts');
if (!existsSync(entryPoint)) {
  console.info('[volt:ext] entry point not yet created (Phase 2). Skipping build.');
  process.exit(0);
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/**
 * Resolve bare module specifiers directly against this project's
 * `node_modules/`, bypassing any ambient `.pnp.cjs` Yarn Plug'n'Play
 * manifest found in ancestor directories (e.g. a stale one in the
 * developer's home).
 *
 * esbuild's auto-detected PnP resolver blocks standard `node_modules`
 * resolution; this plugin short-circuits it for every dependency
 * (including transitive ones like ajv's `fast-deep-equal`).
 *
 * Node built-ins and `vscode` are passed through unchanged.
 */
const pnpBypassPlugin = {
  name: 'volt-pnp-bypass',
  setup(/** @type {esbuild.PluginBuild} */ build) {
    const filter = /^[^./]/;
    build.onResolve({ filter }, (/** @type {esbuild.OnResolveArgs} */ args) => {
      if (args.path === 'vscode' || NODE_BUILTINS.has(args.path)) return undefined;
      const slash = args.path.indexOf('/');
      const pkgName = slash === -1 ? args.path : args.path.slice(0, slash);
      const pkgDir = resolve(__dirname, 'node_modules', pkgName);
      try {
        const req = createRequire(resolve(pkgDir, 'package.json'));
        return { path: req.resolve(args.path) };
      } catch {
        return undefined;
      }
    });
  },
};

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [entryPoint],
  bundle: true,
  outfile: resolve(__dirname, 'dist/extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify: !isWatch,
  external: ['vscode'],
  plugins: [pnpBypassPlugin],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
  },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[volt:ext] watching for changes…');
} else {
  await esbuild.build(options);
  console.log('[volt:ext] build complete');
}
