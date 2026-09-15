import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: mode === 'development' ? false : 'esbuild',
    rollupOptions: {
      input: {
        popup: 'popup.html',
        library: 'library.html',
        worker: 'src/worker.ts',
        content: 'src/content.ts'
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'worker' || chunk.name === 'content' ? '[name].js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
}));
