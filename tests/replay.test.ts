import { describe, expect, it } from 'vitest';
import { replay } from '../src/replay';
import type { SavedFilling } from '../src/types';

const form = { origin: 'https://example.test', pathname: '/', formId: 'main', formName: '', actionOrigin: 'https://example.test', actionPath: '/', method: 'POST', fingerprint: 'form', formIndex: 0 };

function fileFilling(path?: string): SavedFilling {
  return { id: 'entry', schemaVersion: 1, name: 'Test', form, fields: [{ descriptor: { key: 'file-field', kind: 'file', name: 'attachment', id: 'attachment', label: 'Attachment', index: 0 }, value: { tag: 'file', files: [{ name: 'private-name.pdf', path }] }, included: true }], createdAt: 1, updatedAt: 1 };
}
function fileCdp(calls: string[], setError?: string) {
  return async (method: string, params?: Record<string, unknown>): Promise<any> => {
    calls.push(method);
    if (method === 'Runtime.evaluate') return params?.returnByValue === false ? { result: { objectId: 'input' } } : { result: { value: { files: [] } } };
    if (method === 'DOM.requestNode') return { nodeId: 1 };
    if (method === 'DOM.setFileInputFiles' && setError) throw new Error(setError);
    return {};
  };
}

describe('CDP replay', () => {
  it('explains that old entries must be saved again when no path was captured', async () => {
    const calls: string[] = [];
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const result = await replay(fileCdp(calls), fileFilling(), () => false, (event, details) => events.push({ event, details }));
    expect(result.fields[0]).toMatchObject({ status: 'manual' });
    expect(result.fields[0].message).toContain('save the form again');
    expect(events.find(({ event }) => event === 'file.replay.paths')?.details).toMatchObject({ fileCount: 1, reusablePathCount: 0, pathStatuses: ['missing'] });
    expect(calls).not.toContain('DOM.setFileInputFiles');
    expect(JSON.stringify(events)).not.toContain('private-name.pdf');
  });

  it('reports disabled extension file access before setting a stored file path', async () => {
    const calls: string[] = [];
    const result = await replay(fileCdp(calls), fileFilling('C:\\private\\private-name.pdf'), () => false, undefined, false, false);
    expect(result.fields[0].status).toBe('manual');
    expect(result.fields[0].message).toContain('Allow access to file URLs');
    expect(calls).not.toContain('DOM.setFileInputFiles');
  });

  it('reports CDP permission denial with recovery instructions when the preflight is unavailable', async () => {
    const calls: string[] = [];
    const result = await replay(fileCdp(calls, '{"code":-32000,"message":"Not allowed"}'), fileFilling('C:\\private\\private-name.pdf'), () => false);
    expect(calls).toContain('DOM.setFileInputFiles');
    expect(result.fields[0].status).toBe('manual');
    expect(result.fields[0].message).toContain('Allow access to file URLs');
    expect(JSON.stringify(result)).not.toContain('private-name.pdf');
  });

  it('rejects fake paths from legacy entries', async () => {
    const calls: string[] = [];
    const result = await replay(fileCdp(calls), fileFilling('C:\\fakepath\\private-name.pdf'), () => false);
    expect(result.fields[0].status).toBe('manual');
    expect(calls).not.toContain('DOM.setFileInputFiles');
  });

  it('falls back to the backend node id for file inputs when requestNode returns zero', async () => {
    const calls: string[] = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      calls.push(method);
      if (method === 'Runtime.evaluate' && params?.returnByValue === false) return { result: { objectId: 'field-object' } };
      if (method === 'DOM.requestNode') return { nodeId: 0 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [7] };
      if (method === 'Runtime.evaluate') return { result: { value: { value: '', checked: false, files: ['resume.pdf'] } } };
      return {};
    };
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, fields: [{ descriptor: { key: 'file|resume|resume|0', kind: 'file', name: 'resume', id: 'resume', label: 'Resume', index: 0, typeSignature: 'file|resume|resume', formId: 'main' }, value: { tag: 'file', files: [{ path: 'C:\\resume.pdf', name: 'resume.pdf' }] }, included: true }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false);
    expect(result.fields[0].status).toBe('filled');
    expect(calls).toContain('DOM.describeNode');
    expect(calls).toContain('DOM.pushNodesByBackendIdsToFrontend');
  });

  it('sets a text field through the DOM and does not use input-device events', async () => {
    let value = 'old value';
    const calls: string[] = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      calls.push(method);
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && expression.includes("fire('input')")) { value = 'new value'; return { result: { value: true } }; }
      if (method === 'Runtime.evaluate') return { result: { value: { value, checked: false } } };
      return {};
    };
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, fields: [{ descriptor: { key: 'text|name|name|0', kind: 'text', name: 'name', id: 'name', label: 'Name', index: 0, typeSignature: 'text|name|name', formId: 'main' }, value: { tag: 'text', value: 'new value' }, included: true }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false);
    expect(result.status).toBe('completed');
    expect(result.fields[0].status).toBe('filled');
    expect(value).toBe('new value');
    expect(calls.every((method) => !method.startsWith('Input.') && method !== 'DOM.focus')).toBe(true);
  });

  it('includes the field label in a failed fill result', async () => {
    const cdp = async (): Promise<any> => ({ result: { value: false } });
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, fields: [{ descriptor: { key: 'text|email|email|0', kind: 'text', name: 'email', id: 'email', label: 'Work email', index: 0, typeSignature: 'text|email|email', formId: 'main' }, value: { tag: 'text', value: 'new@example.test' }, included: true }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false);
    expect(result.fields[0]).toMatchObject({ fieldName: 'Work email', status: 'failed' });
  });

  it('waits after the complete filling has been verified', async () => {
    const events: string[] = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && expression.includes("fire('input')")) return { result: { value: true } };
      if (method === 'Runtime.evaluate') return { result: { value: { value: 'new value', checked: false } } };
      return {};
    };
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, waitAfterFillMs: 20, fields: [{ descriptor: { key: 'text|name|name|0', kind: 'text', name: 'name', id: 'name', label: 'Name', index: 0, typeSignature: 'text|name|name', formId: 'main' }, value: { tag: 'text', value: 'new value' }, included: true }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false, (event) => events.push(event));
    expect(result.status).toBe('completed');
    expect(events.indexOf('field.filled')).toBeLessThan(events.indexOf('wait.start'));
    expect(events.indexOf('wait.start')).toBeLessThan(events.indexOf('wait.complete'));
  });

  it('uses a field wait override instead of the filling default', async () => {
    const waits: number[] = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && expression.includes("fire('input')")) return { result: { value: true } };
      if (method === 'Runtime.evaluate') return { result: { value: { value: 'new value', checked: false } } };
      return {};
    };
    const field = (key: string, index: number): SavedFilling['fields'][number] => ({ descriptor: { key, kind: 'text', name: key, id: key, label: key, index, typeSignature: `text|${key}|${key}` }, value: { tag: 'text', value: 'new value' }, included: true });
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, waitAfterFillMs: 1, fields: [{ ...field('first', 0) }, { ...field('second', 1), waitAfterFillMs: 5 }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false, (event, details) => { if (event === 'wait.start') waits.push(details?.delayMs as number); });
    expect(result.status).toBe('completed');
    expect(waits).toEqual([1, 5]);
  });

  it('logs every locator criterion without logging the saved value', async () => {
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('formAttempts')) return { result: { value: { matched: false, decision: 'missing', attempts: [{ strategy: 'id', expected: 'name', compatibleMatches: 0 }] } } };
      return {};
    };
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form, fields: [{ descriptor: { key: 'text|name|name|0', kind: 'text', name: 'name', id: 'name', label: 'Name', index: 0, typeSignature: 'text|name|name', formId: 'main' }, value: { tag: 'text', value: 'secret value' }, included: true }], createdAt: 1, updatedAt: 1 };
    await replay(cdp, filling, () => false, (event, details) => events.push({ event, details }), true);
    expect(events.find((item) => item.event === 'field.match')?.details).toMatchObject({ fieldIndex: 0, matched: false, decision: 'missing' });
    expect(JSON.stringify(events)).not.toContain('secret value');
  });

  it('sets a matching radio whose value is correct but is not checked', async () => {
    let checked = false;
    const calls: string[] = [];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      calls.push(method);
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && expression.includes("fire('input')")) { checked = true; return { result: { value: true } }; }
      if (method === 'Runtime.evaluate') return { result: { value: { value: 'daily', checked } } };
      return {};
    };
    const filling: SavedFilling = { id: 'radio-entry', schemaVersion: 1, name: 'Radio', form, fields: [{ descriptor: { key: 'radio|daily|frequency|0', kind: 'radio', name: 'frequency', id: 'daily', label: 'Daily', index: 0, typeSignature: 'radio|frequency|daily', formId: 'main' }, value: { tag: 'radio', value: 'daily' }, included: true }], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false);
    expect(result.fields[0].status).toBe('filled');
    expect(calls.some((method) => method.startsWith('Input.') || method === 'DOM.focus')).toBe(false);
  });

  it('sets single and multiple select values through the DOM', async () => {
    const expressions: string[] = [];
    let selected = ['blue'];
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        expressions.push(expression);
        if (expression.includes("fire('input')")) {
          if (expression.includes('one') && expression.includes('two')) selected = ['one', 'two'];
          return { result: { value: true } };
        }
        return { result: { value: { value: selected[0] ?? '', selected } } };
      }
      return {};
    };
    const filling: SavedFilling = { id: 'select-entry', schemaVersion: 1, name: 'Selects', form, fields: [
      { descriptor: { key: 'select-one|color|color|0', kind: 'select-one', name: 'color', id: 'color', label: 'Color', index: 0, typeSignature: 'select-one|color|color', formId: 'main' }, value: { tag: 'options', values: ['blue'] }, included: true },
      { descriptor: { key: 'select-multiple|tags|tags|1', kind: 'select-multiple', name: 'tags', id: 'tags', label: 'Tags', index: 1, typeSignature: 'select-multiple|tags|tags', formId: 'main' }, value: { tag: 'options', values: ['one', 'two'] }, included: true },
    ], createdAt: 1, updatedAt: 1 };
    const result = await replay(cdp, filling, () => false);
    expect(result.status).toBe('completed');
    expect(result.fields.every((field) => field.status === 'filled')).toBe(true);
    expect(expressions.some((expression) => expression.includes('option.selected=values.has(option.value)'))).toBe(true);
  });

  it('generates a locator that prefers the current form position and supports accessible labels and text-like type changes', async () => {
    let locatorExpression = '';
    let traceExpression = '';
    const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && expression.includes('formAttempts')) {
        traceExpression = expression;
        return { result: { value: { matched: false } } };
      }
      if (method === 'Runtime.evaluate' && expression.includes('const value=')) {
        locatorExpression = expression;
        return { result: { value: true } };
      }
      return {};
    };
    const filling: SavedFilling = { id: 'entry', schemaVersion: 1, name: 'Test', form: { ...form, formId: 'duplicate', formName: 'duplicate', formIndex: 2 }, fields: [{ descriptor: { key: 'email|email|generated|0', kind: 'email', name: 'email', id: 'generated', label: 'Email', index: 0, typeSignature: 'email|email|generated' }, value: { tag: 'text', value: 'new@example.test' }, included: true }], createdAt: 1, updatedAt: 1 };
    await replay(cdp, filling, () => false, () => undefined, true);
    expect(locatorExpression.indexOf('document.forms[2]')).toBeLessThan(locatorExpression.indexOf('document.getElementById'));
    expect(locatorExpression).toContain("getAttribute('aria-labelledby')");
    expect(locatorExpression).toContain('textKinds.includes(actual)');
    expect(locatorExpression).toContain('"strategy":"id"');
    expect(locatorExpression).toContain('"strategy":"name"');
    expect(locatorExpression).toContain('"strategy":"label"');
    expect(locatorExpression).toContain('"strategy":"position"');
    expect(traceExpression).toContain('split(/\\s+/)');
    expect(traceExpression).toContain('for(const key of serializedKeys)');
  });
});
