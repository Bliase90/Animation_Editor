import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'] },
} as any);
