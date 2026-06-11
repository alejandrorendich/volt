import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/webview',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/webview/main.tsx'),
      },
      output: {
        // Single bundle — no code splitting; webview CSP prohibits dynamic imports
        inlineDynamicImports: true,
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
