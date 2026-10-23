import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Element {
  children: Element[] = [];
  style = {};
  dataset = {};
  textContent = '';
  hidden = false;
  className = '';
  id = '';
  name = '';
  method = 'get';
  listeners = new Map<string, () => void>();
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener); }
  attachShadow() { const shadow = new Element(); this.children.push(shadow); return shadow; }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}

describe('content script vault initialization', () => {
  let respondToStatus: (response: unknown) => void;
  let receive: (message: unknown) => void;
  let sendMessage: ReturnType<typeof vi.fn>;
  let observe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    observe = vi.fn();
    sendMessage = vi.fn((message, callback) => {
      if (message.type === 'GET_SITE_STATUS') respondToStatus = callback;
      else callback({ ok: true });
    });
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() });
    vi.stubGlobal('location', { origin: 'https://example.test' });
    vi.stubGlobal('document', { forms: [], documentElement: {}, addEventListener: vi.fn() });
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('MutationObserver', class { observe = observe; });
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      },
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('receives an unlock during startup and ignores the older locked status', async () => {
    await import('../src/content');
    expect(receive).toBeTypeOf('function');
    receive({ type: 'VAULT_STATE', unlocked: true });
    respondToStatus({ ok: true, status: { enabled: true, unlocked: false } });
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_PENDING_SUBMISSION' }), expect.any(Function));
  });

  it('receives a lock during startup and ignores the older unlocked status', async () => {
    await import('../src/content');
    receive({ type: 'VAULT_STATE', unlocked: false });
    respondToStatus({ ok: true, status: { enabled: true, unlocked: true } });
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    expect(sendMessage.mock.calls.map((call) => call[0].type)).toEqual(['GET_SITE_STATUS']);
  });

  it('opens a trusted extension unlock form from the website control and refreshes after unlock', async () => {
    const root = new Element(); const form = new Element();
    vi.stubGlobal('location', { origin: 'https://example.test', href: 'https://example.test/form' });
    vi.stubGlobal('document', { forms: [form], documentElement: root, addEventListener: vi.fn(), createElement: () => new Element(), createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }), querySelectorAll: () => [], contains: () => true });
    await import('../src/content');
    respondToStatus({ ok: true, status: { enabled: true, unlocked: false } });
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    const unlock = root.all().find((node) => node.textContent === 'Unlock vault');
    expect(unlock).toBeDefined(); unlock!.listeners.get('click')!();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_LIBRARY' }), expect.any(Function)));
    receive({ type: 'VAULT_STATE', unlocked: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIST_MATCHES' }), expect.any(Function)));
    expect(root.all().map((node) => node.textContent)).toContain('Save current filling');
    receive({ type: 'VAULT_STATE', unlocked: false });
    expect(root.all().map((node) => node.textContent)).toContain('Unlock vault');
  });
});
