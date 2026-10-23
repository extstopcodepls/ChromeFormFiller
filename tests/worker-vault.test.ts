import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Response } from '../src/messages';
import { createVault } from '../src/crypto';

vi.mock('../src/crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/crypto')>(),
  createVault: vi.fn(async () => ({ meta: { version: 1, salt: 'salt', wrappedKey: 'key', wrapIv: 'iv' }, dataKey: new Uint8Array(32).fill(7) })),
  unlockVault: vi.fn(async (passphrase: string) => {
    if (passphrase !== 'correct passphrase') throw new Error('Wrong passphrase');
    return new Uint8Array(32).fill(7);
  }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('worker vault state', () => {
  let session: Record<string, unknown>;
  let local: Record<string, unknown>;
  let dispatch: (message: Message) => Promise<Response>;
  let sessionSet: ReturnType<typeof vi.fn>;
  let sessionClear: ReturnType<typeof vi.fn>;
  let sendToTab: ReturnType<typeof vi.fn>;
  let startup: () => void;
  let getScripts: ReturnType<typeof vi.fn>;
  let registerScripts: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    session = {};
    local = {};
    const event = () => ({ addListener: vi.fn() });
    sessionSet = vi.fn(async (values) => { Object.assign(session, values); });
    sessionClear = vi.fn(async () => { for (const key of Object.keys(session)) delete session[key]; });
    sendToTab = vi.fn(async () => undefined);
    getScripts = vi.fn(async () => []);
    registerScripts = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(async (key) => ({ [key]: local[key] })), set: vi.fn(async (values) => { Object.assign(local, values); }) },
        session: { get: vi.fn(async (key) => ({ [key]: session[key] })), set: sessionSet, clear: sessionClear, remove: vi.fn() },
      },
      runtime: {
        onMessage: { addListener: (listener: (message: Message, sender: object, respond: (response: Response) => void) => boolean) => {
          dispatch = (message) => new Promise((resolve) => { listener(message, {}, resolve); });
        } },
        onStartup: { addListener: (listener: () => void) => { startup = listener; } }, onInstalled: event(),
      },
      tabs: { query: vi.fn(async () => [{ id: 1 }]), sendMessage: sendToTab, onRemoved: event() },
      permissions: { contains: vi.fn(async () => true), onAdded: event(), onRemoved: event() },
      scripting: { getRegisteredContentScripts: getScripts, registerContentScripts: registerScripts, executeScript: vi.fn(async () => undefined) },
      debugger: { onDetach: event() },
      alarms: { create: vi.fn(), onAlarm: event() },
    });
    await import('../src/worker');
    await dispatch({ type: 'GET_SITE_STATUS', requestId: 'ready' });
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const unlockMessage: Message = { type: 'UNLOCK_VAULT', requestId: 'unlock', passphrase: 'correct passphrase' };

  it('keeps the first unlock when a status request overlaps its session write', async () => {
    const gate = deferred();
    sessionSet.mockImplementationOnce(async (values) => { await gate.promise; Object.assign(session, values); });
    const unlock = dispatch(unlockMessage);
    await vi.waitFor(() => expect(sessionSet).toHaveBeenCalled());
    const status = dispatch({ type: 'GET_SITE_STATUS', requestId: 'during-unlock' });
    // Let the concurrent request reach the vault state check before committing.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    gate.resolve();
    expect(await unlock).toMatchObject({ ok: true });
    expect(await status).toMatchObject({ ok: true, status: { unlocked: true } });
    expect(await dispatch({ type: 'LIST_LIBRARY', requestId: 'library' })).toMatchObject({ ok: true });
    expect(sessionClear).not.toHaveBeenCalled();
    expect(sendToTab).toHaveBeenCalledWith(1, { type: 'VAULT_STATE', unlocked: true });
  });

  it('finishes an in-flight lock before committing a new unlock', async () => {
    await dispatch(unlockMessage);
    const gate = deferred();
    sessionClear.mockImplementationOnce(async () => { await gate.promise; for (const key of Object.keys(session)) delete session[key]; });
    const lock = dispatch({ type: 'LOCK_VAULT', requestId: 'lock' });
    await vi.waitFor(() => expect(sessionClear).toHaveBeenCalled());
    const unlock = dispatch(unlockMessage);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    gate.resolve();
    await lock;
    expect(await unlock).toMatchObject({ ok: true });
    expect(await dispatch({ type: 'GET_SITE_STATUS', requestId: 'after-lock' })).toMatchObject({ ok: true, status: { unlocked: true } });
    expect(sendToTab.mock.calls.slice(-2).map((call) => call[1].unlocked)).toEqual([false, true]);
  });

  it('allows a correct unlock after a failed passphrase attempt', async () => {
    await dispatch(unlockMessage);
    await dispatch({ type: 'LOCK_VAULT', requestId: 'lock' });
    expect(await dispatch({ ...unlockMessage, passphrase: 'wrong passphrase' })).toMatchObject({ ok: false });
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
    expect(await dispatch({ type: 'LIST_LIBRARY', requestId: 'library' })).toMatchObject({ ok: true });
  });

  it('still locks a vault after thirty minutes of inactivity', async () => {
    await dispatch(unlockMessage);
    session.activityAt = Date.now() - 30 * 60 * 1000;
    expect(await dispatch({ type: 'GET_SITE_STATUS', requestId: 'expired' })).toMatchObject({ ok: true, status: { unlocked: false } });
    expect(session.sessionDataKey).toBeUndefined();
    expect(await dispatch({ type: 'LIST_LIBRARY', requestId: 'locked' })).toMatchObject({ ok: false });
  });

  it('does not wait for a page notification response to unlock or expire the vault', async () => {
    sendToTab.mockReturnValue(new Promise(() => {}));
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
    session.activityAt = Date.now() - 30 * 60 * 1000;
    expect(await dispatch({ type: 'GET_SITE_STATUS', requestId: 'expired' })).toMatchObject({ ok: true, status: { unlocked: false } });
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
  });

  it('times out derivation, releases the queue, and ignores a late vault creation', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    vi.mocked(createVault).mockImplementationOnce(async () => { await gate.promise; return { meta: { version: 1, salt: 'late', wrappedKey: 'late', wrapIv: 'late' }, dataKey: new Uint8Array(32).fill(9) }; });
    const first = dispatch(unlockMessage);
    const queued = dispatch({ ...unlockMessage, requestId: 'queued' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await first).toMatchObject({ ok: false, error: 'Unlock timed out. Try again.' });
    expect(await queued).toMatchObject({ ok: false, error: 'Unlock timed out. Try again.' });
    expect(await dispatch({ type: 'GET_SITE_STATUS', requestId: 'after-timeout' })).toMatchObject({ status: { unlocked: false } });
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(local.vaultMeta).toMatchObject({ salt: 'salt' });
    expect(session.sessionDataKey).toBe(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  });

  it('keeps the worker responsive while startup script registration is stalled', async () => {
    local.config = { enabledOrigins: ['https://example.test'] };
    getScripts.mockReturnValue(new Promise(() => {}));
    vi.resetModules(); await import('../src/worker');
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
    expect(await dispatch({ type: 'GET_SITE_STATUS', requestId: 'status' })).toMatchObject({ status: { unlocked: true } });
    expect(getScripts).toHaveBeenCalled();
  });

  it('accepts a duplicate registration only when Chrome confirms the script exists', async () => {
    local.config = { enabledOrigins: ['https://example.test'] };
    getScripts.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'registered' }]);
    registerScripts.mockRejectedValueOnce(new Error('Duplicate script ID'));
    startup();
    await vi.waitFor(() => expect(getScripts).toHaveBeenCalledTimes(2));
    expect(await dispatch(unlockMessage)).toMatchObject({ ok: true });
    expect(registerScripts).toHaveBeenCalledOnce();
  });
});
