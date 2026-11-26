import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
          if (
            id.includes('node_modules/@codemirror') ||
            id.includes('node_modules/codemirror') ||
            id.includes('node_modules/@lezer') ||
            id.includes('node_modules/yjs') ||
            id.includes('node_modules/y-codemirror.next') ||
            id.includes('node_modules/y-protocols') ||
            id.includes('node_modules/@hocuspocus') ||
            id.includes('node_modules/lib0')
          ) {
            return 'editor-collab';
          }
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/lucide-react')
          ) {
            return 'ui-vendor';
          }
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
      '/collab': {
        target: 'http://127.0.0.1:3456',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
