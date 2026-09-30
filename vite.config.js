import { defineConfig } from 'vite';

// Relative base so the build runs from any folder or static host.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
});
