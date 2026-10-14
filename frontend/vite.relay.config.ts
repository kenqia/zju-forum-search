import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    ssr: '../relay/index.ts',
    outDir: '../relay/dist',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
});
