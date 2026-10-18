import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const file = id.replaceAll('\\', '/');
          if (file.includes('/node_modules/zod/')) return 'schema';
          if (/\/node_modules\/(?:@xyflow|d3-|zustand|classcat)/.test(file)) return 'canvas';
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(file)) return 'react';
        },
      },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
