import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base './' so the same build works at github.io/load/ and on the Mac hub at /.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: './',
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'safari15' },
  server: {
    port: 5173,
    proxy: { '/gh': 'http://127.0.0.1:8766', '/api': 'http://127.0.0.1:8766' },
  },
});
