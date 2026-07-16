// @ts-check
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

const entryPoint = resolve(__dirname, 'src/extension/activate.ts');
if (!existsSync(entryPoint)) {
  console.info('[volt:ext] entry point not yet created (Phase 2). Skipping build.');
  process.exit(0);
}

/**
 * Runtime dependencies that must be loaded via Node's `require()` at runtime
 * instead of being bundled. They are listed under `dependencies` in
 * `package.json`, so `vsce package` ships them alongside the extension and
 * Node's standard resolution finds them at runtime — bypassing Yarn PnP
 * interference that breaks bundling in some local environments.
 */
const RUNTIME_EXTERNALS = ['vscode', 'js-yaml', 'undici', 'ajv', 'ajv-formats'];

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
  external: RUNTIME_EXTERNALS,
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
