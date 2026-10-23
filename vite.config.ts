import { defineConfig, type Plugin } from 'vite';

// Chrome injects this entry as a classic script. Scope the complete output,
// including bundled helpers, so repeated injection cannot redeclare globals.
export function contentScriptScope(): Plugin {
  return {
    name: 'content-script-scope',
    generateBundle(_options, bundle) {
      const content = bundle['content.js'];
      if (!content || content.type !== 'chunk') return;
      if (content.imports.length || content.dynamicImports.length) throw new Error('The content script must be a standalone bundle.');
      content.code = `(() => {\n${content.code}\n})();`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [contentScriptScope()],
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
