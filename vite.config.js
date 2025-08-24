import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      input: './frontend.jsx',
      output: {
        entryFileNames: 'bundle.js',
        assetFileNames: 'bundle.[ext]'
      }
    }
  }
});
