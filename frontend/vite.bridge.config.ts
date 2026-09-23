import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/extension/sites/cc98/webvpn-bridge.ts',
      name: 'ZjuForumSearchWebVpnBridge',
      formats: ['iife'],
      fileName: () => 'cc98-webvpn-bridge.js',
    },
  },
});
