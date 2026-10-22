import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
