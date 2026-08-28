import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the API runs separately; in production the API process serves this build.
    proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
