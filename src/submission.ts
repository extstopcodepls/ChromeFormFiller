// Delay the first submit event so navigation and page submit handlers cannot
// remove file controls while the worker reads their paths. Re-dispatch through
// requestSubmit so validation, submitter overrides and site handlers still run.
export function createSubmissionGate(timeoutMs = 10_000) {
  const pending = new WeakSet<HTMLFormElement>();
  const resuming = new WeakSet<HTMLFormElement>();
  return (event: Event, form: HTMLFormElement, capture: () => Promise<unknown>, finished: (outcome: string) => void = () => undefined, shouldDelay = true): boolean => {
    if (resuming.has(form)) return true;
    if (!pending.has(form) && !shouldDelay) return false;
    if (!event.cancelable || event.defaultPrevented) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending.has(form)) return true;
    pending.add(form);
    const submitter = (event as SubmitEvent).submitter;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const captured = Promise.resolve().then(capture).then(() => 'captured', () => 'error');
    void Promise.race([captured, timeout]).then((outcome) => {
      clearTimeout(timer);
      pending.delete(form);
      finished(outcome);
      if (!form.isConnected) return;
      // A detached/reassigned submitter cannot be passed to requestSubmit.
      // Do not silently submit with different overrides or omit its value.
      if (submitter && (submitter as HTMLButtonElement | HTMLInputElement).form !== form) return;
      resuming.add(form);
      try { HTMLFormElement.prototype.requestSubmit.call(form, submitter ?? undefined); }
      finally { resuming.delete(form); }
    });
    return true;
  };
}
