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
