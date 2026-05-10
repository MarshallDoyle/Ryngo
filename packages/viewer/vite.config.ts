import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// codegraph viewer is a static SPA. No backend, no proxy.
// We resolve `@/*` to `src/*` to keep imports tidy across the tree.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // ELK is large; let it split into its own chunk.
    rollupOptions: {
      output: {
        manualChunks: {
          elk: ['elkjs'],
          reactflow: ['@xyflow/react'],
        },
      },
    },
  },
});
