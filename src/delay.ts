export const MAX_WAIT_AFTER_FILL_MS = 2_147_483_647;

export function normalizeWaitAfterFillMs(value: unknown, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_WAIT_AFTER_FILL_MS) {
    throw new Error(`Wait after filling must be a whole number from 0 to ${MAX_WAIT_AFTER_FILL_MS} milliseconds.`);
  }
  return value;
}

export function normalizeWaitAfterFillOverrideMs(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : normalizeWaitAfterFillMs(value);
}

/** Waits while still allowing a fill cancellation to interrupt the delay. */
export function waitAfterFill(ms: number, isCanceled: () => boolean): Promise<boolean> {
  if (ms === 0) return Promise.resolve(!isCanceled());
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (isCanceled()) { resolve(false); return; }
      const remaining = ms - (Date.now() - startedAt);
      if (remaining <= 0) { resolve(true); return; }
      setTimeout(poll, Math.min(50, remaining));
    };
    poll();
  });
}
