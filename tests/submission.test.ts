import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubmissionGate } from '../src/submission';

class TestForm extends EventTarget {
  isConnected = true;
  submissions: Array<HTMLElement | undefined> = [];
  requestSubmit(submitter?: HTMLElement) {
    const event = submitEvent(submitter);
    if (this.dispatchEvent(event)) this.submissions.push(submitter);
  }
}
function submitEvent(submitter?: HTMLElement) {
  return Object.assign(new Event('submit', { cancelable: true }), { submitter: submitter ?? null });
}
function fixture(capture: () => Promise<unknown>, timeout = 10_000) {
  vi.stubGlobal('HTMLFormElement', TestForm);
  const form = new TestForm();
  const gate = createSubmissionGate(timeout);
  const observed = vi.fn(capture);
  const finished = vi.fn();
  const siteHandler = vi.fn();
  form.addEventListener('submit', (event) => gate(event, form as unknown as HTMLFormElement, observed, finished));
  form.addEventListener('submit', siteHandler);
  const submitter = { form, name: 'action', value: 'upload', formAction: '/upload', formMethod: 'post' } as unknown as HTMLElement;
  return { form, submitter, observed, finished, siteHandler };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('submission capture gate', () => {
  it('holds navigation and page handlers until capture completes, then preserves the submitter exactly once', async () => {
    let complete!: () => void;
    const test = fixture(() => new Promise<void>((resolve) => { complete = resolve; }));
    test.form.requestSubmit(test.submitter);
    await settle();
    expect(test.form.submissions).toEqual([]);
    expect(test.siteHandler).not.toHaveBeenCalled();
    complete();
    await settle();
    expect(test.observed).toHaveBeenCalledTimes(1);
    expect(test.siteHandler).toHaveBeenCalledTimes(1);
    expect(test.form.submissions).toEqual([test.submitter]);
  });

  it('coalesces repeated submits while capture is pending', async () => {
    let complete!: () => void;
    const test = fixture(() => new Promise<void>((resolve) => { complete = resolve; }));
    test.form.requestSubmit(test.submitter);
    test.form.requestSubmit(test.submitter);
    await settle();
    complete();
    await settle();
    expect(test.observed).toHaveBeenCalledTimes(1);
    expect(test.form.submissions).toEqual([test.submitter]);
  });

  it('continues on capture failure and supports a submission without a submitter', async () => {
    const test = fixture(() => Promise.reject(new Error('Debugger unavailable')));
    test.form.requestSubmit();
    await settle();
    expect(test.form.submissions).toEqual([undefined]);
    expect(test.finished).toHaveBeenCalledWith('error');
  });

  it('continues after the timeout and does not submit again on a late response', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const test = fixture(() => new Promise<void>((resolve) => { complete = resolve; }), 100);
    test.form.requestSubmit(test.submitter);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.form.submissions).toEqual([test.submitter]);
    expect(test.finished).toHaveBeenCalledWith('timeout');
    complete();
    await settle();
    expect(test.form.submissions).toHaveLength(1);
  });

  it('lets site handlers cancel the resumed submission', async () => {
    const test = fixture(async () => undefined);
    test.form.addEventListener('submit', (event) => event.preventDefault());
    test.form.requestSubmit(test.submitter);
    await settle();
    expect(test.siteHandler).toHaveBeenCalledTimes(1);
    expect(test.form.submissions).toEqual([]);
  });

  it.each(['form', 'submitter'])('does not resume when the %s is removed during capture', async (removed) => {
    const test = fixture(async () => {
      if (removed === 'form') test.form.isConnected = false;
      else (test.submitter as unknown as { form: null }).form = null;
    });
    test.form.requestSubmit(test.submitter);
    await settle();
    expect(test.form.submissions).toEqual([]);
  });

  it('leaves non-file, already canceled, and noncancelable events alone', () => {
    const gate = createSubmissionGate();
    const form = new TestForm() as unknown as HTMLFormElement;
    const capture = vi.fn();
    const ordinary = submitEvent();
    expect(gate(ordinary, form, capture, undefined, false)).toBe(false);
    expect(ordinary.defaultPrevented).toBe(false);
    const canceled = submitEvent();
    canceled.preventDefault();
    expect(gate(canceled, form, capture)).toBe(false);
    expect(gate(new Event('submit'), form, capture)).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});
