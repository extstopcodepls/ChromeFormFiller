import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { contentScriptScope } from '../vite.config';

describe('classic content script bundle', () => {
  it.each([false, 'esbuild'])('can be injected twice with minify=%s', async (minify) => {
    const output = await build({
      configFile: false, logLevel: 'silent', plugins: [contentScriptScope()],
      build: { write: false, minify, rollupOptions: { input: { content: 'src/content.ts' }, output: { entryFileNames: 'content.js' } } },
    });
    const chunk = output.output.find((item) => item.fileName === 'content.js');
    const listen = vi.fn(); const send = vi.fn();
    const context = createContext({ window: {}, crypto: { randomUUID: () => 'request' }, document: { addEventListener: vi.fn() }, chrome: { runtime: { onMessage: { addListener: listen }, sendMessage: send } } });
    runInContext(chunk.code, context);
    expect(() => runInContext(chunk.code, context)).not.toThrow();
    expect(listen).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    expect(chunk.imports).toEqual([]);
  });
});
