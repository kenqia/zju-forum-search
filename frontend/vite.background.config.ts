import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
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
