import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The popup only needs element creation and events; model these without a browser.
class Element {
  children: Element[] = [];
  textContent = '';
  id = '';
  hidden = false;
  type = '';
  value = '';
  disabled = false;
  listeners = new Map<string, (...args: any[]) => void>();
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  addEventListener(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, listener); }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}

describe('popup startup recovery', () => {
  let app: Element;
  let query: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let runtime: { lastError?: { message: string }; sendMessage: ReturnType<typeof vi.fn>; openOptionsPage: ReturnType<typeof vi.fn> };
  const status = { origin: 'https://example.test', enabled: false, unlocked: false, pendingCount: 0, debug: false };
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
  const texts = () => app.all().map((node) => node.textContent);
  const click = (text: string) => {
    const button = app.all().find((node) => node.tag === 'button' && node.textContent === text);
    expect(button).toBeDefined();
    button!.listeners.get('click')!();
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    app = new Element('main');
    query = vi.fn().mockResolvedValue([{ url: status.origin }]);
    send = vi.fn((_message, callback) => callback({ ok: true, status }));
    runtime = { sendMessage: send, openOptionsPage: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal('chrome', { tabs: { query }, runtime });
    vi.stubGlobal('document', {
      createElement: (tag: string) => new Element(tag),
      querySelector: (selector: string) => selector === '#app' ? app : app.all().find((node) => `#${node.id}` === selector),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('shows loading immediately while the background worker starts', async () => {
    query.mockReturnValue(new Promise(() => {}));
    await import('../src/popup');
    expect(texts()).toContain('Form Filler');
    expect(texts()).toContain('Connecting to the extension…');
  });

  it('shows a disconnected-worker error and recovers on retry', async () => {
    send.mockImplementationOnce((_message, callback) => {
      runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      callback(undefined);
      delete runtime.lastError;
    });
    await import('../src/popup'); await flush();
    expect(texts()).toContain('Could not establish connection. Receiving end does not exist.');
    click('Try again'); await flush();
    expect(texts()).toContain('Enable on this site');
    expect(texts()).not.toContain('Try again');
  });

  it('renders tab-query failures instead of leaving the popup blank', async () => {
    query.mockRejectedValue(new Error('Tab query failed'));
    await import('../src/popup'); await flush();
    expect(texts()).toContain('Tab query failed');
    expect(texts()).toContain('Try again');
  });

  it('renders an empty worker response as a recoverable error', async () => {
    send.mockImplementationOnce((_message, callback) => callback(undefined));
    await import('../src/popup'); await flush();
    expect(texts()).toContain('Empty response');
    click('Open saved fillings');
    expect(runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('times out a stalled worker and ignores its late response after retry', async () => {
    let oldCallback: (response: unknown) => void = () => {};
    send.mockImplementationOnce((_message, callback) => { oldCallback = callback; });
    await import('../src/popup'); await flush();
    await vi.advanceTimersByTimeAsync(8000);
    expect(texts()).toContain('The extension did not respond. Try again to reconnect.');
    click('Try again'); await flush();
    expect(texts()).toContain(status.origin);
    oldCallback({ ok: false, error: 'Old request failed' }); await flush();
    expect(texts()).toContain(status.origin);
    expect(texts()).not.toContain('Old request failed');
  });

  it('shows unlock progress and coalesces repeated submissions', async () => {
    send.mockImplementation((message, callback) => { if (message.type !== 'UNLOCK_VAULT') callback({ ok: true, status }); });
    await import('../src/popup'); await flush();
    const form = app.all().find((node) => node.tag === 'form')!;
    const input = form.all().find((node) => node.type === 'password')!;
    input.value = 'correct passphrase';
    const submit = () => form.listeners.get('submit')!({ preventDefault() {} });
    submit(); submit(); await flush();
    expect(texts()).toContain('Unlocking…');
    expect(input.disabled).toBe(true);
    expect(send.mock.calls.filter(([message]) => message.type === 'UNLOCK_VAULT')).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'UNLOCK_VAULT', passphrase: 'correct passphrase' }), expect.any(Function));
  });

  it('recovers from an unlock timeout and ignores the expired attempt after retry', async () => {
    const callbacks: Array<(response: unknown) => void> = [];
    send.mockImplementation((message, callback) => {
      if (message.type === 'UNLOCK_VAULT') callbacks.push(callback);
      else callback({ ok: true, status: { ...status, unlocked: callbacks.length > 1 } });
    });
    await import('../src/popup'); await flush();
    const form = app.all().find((node) => node.tag === 'form')!;
    const input = form.all().find((node) => node.type === 'password')!;
    input.value = 'first passphrase'; form.listeners.get('submit')!({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(texts()).toContain('Unlock timed out. Try again to reconnect.');
    expect(input.disabled).toBe(false); expect(input.value).toBe('');
    input.value = 'correct passphrase'; form.listeners.get('submit')!({ preventDefault() {} });
    callbacks[1]({ ok: true }); await flush();
    expect(texts()).toContain('Lock vault');
    callbacks[0]({ ok: false, error: 'Expired unlock failure' }); await flush();
    expect(texts()).toContain('Lock vault');
    expect(texts()).not.toContain('Expired unlock failure');
  });
});
