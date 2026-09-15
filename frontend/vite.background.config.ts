import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/extension/background.ts',
      name: 'ZjuForumSearchBackground',
      formats: ['iife'],
      fileName: () => 'background.js',
    },
  },
});
