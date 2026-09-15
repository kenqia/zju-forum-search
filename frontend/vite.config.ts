import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/extension/content.tsx',
      name: 'ZjuForumSearchContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    cssCodeSplit: false,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
