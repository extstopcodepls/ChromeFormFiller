import { describe, expect, it } from 'vitest';
import { captureFilePaths } from '../src/replay';
import type { CapturedField, FormSnapshot } from '../src/types';

const unavailableReason = 'A reusable local path was not exposed by Chrome during capture.';
const metadata = (name: string) => ({ name, size: 12, lastModified: 123 });

function fixture(selections: string[][]) {
  const form = { tagName: 'FORM' };
  const inputs = selections.map((names) => ({
    tagName: 'INPUT', type: 'file', form, id: '', name: 'attachments', labels: [],
    getAttribute: () => null,
    // Model the accessor descriptor Chrome exposes for HTMLInputElement.files.
    get files() { return names.map(metadata); },
  }));
  const document = { forms: [form], querySelectorAll: () => inputs };
  const fields: CapturedField[] = selections.map((names, index) => ({
    descriptor: { key: `field-${index}`, kind: 'file', id: '', name: 'attachments', label: '', index },
    value: { tag: 'file', files: names.map(metadata) }, included: true, unavailableReason,
  }));
  const snapshot: FormSnapshot = {
    form: { origin: 'https://example.test', pathname: '/', formId: '', formName: '', formIndex: 0, actionOrigin: 'https://example.test', actionPath: '/', method: 'POST', fingerprint: 'files' },
    fields, capturedAt: 1, revision: 0, completeness: 'complete',
  };
  const objects = new Map<string, any>();
  let nextId = 0;
  let releases = 0;
  const fileInfoCalls: string[] = [];
  const remote = (value: any): any => {
    if (!value || typeof value !== 'object') return { value };
    const objectId = String(++nextId);
    objects.set(objectId, value);
    return { objectId };
  };
  const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
    if (method === 'Runtime.evaluate') return { result: remote(Function('document', `return ${params?.expression}`)(document)) };
    if (method === 'Runtime.getProperties') {
      const descriptors = Object.getOwnPropertyDescriptors(objects.get(String(params?.objectId)));
      // Return numeric properties out of order, as the protocol does not promise ordering.
      return { result: Object.entries(descriptors).reverse().map(([name, descriptor]) => ({ name, ...('value' in descriptor ? { value: remote(descriptor.value) } : { get: { objectId: 'getter' } }) })) };
    }
    if (method === 'DOM.getFileInfo') {
      const name = objects.get(String(params?.objectId)).name;
      fileInfoCalls.push(name);
      if (name === 'unavailable.pdf') throw new Error('File info unavailable');
      return { path: `C:\\uploads\\${name}` };
    }
    if (method === 'Runtime.releaseObjectGroup') { objects.clear(); releases += 1; return {}; }
    throw new Error(`Unexpected CDP method: ${method}`);
  };
  return { snapshot, cdp, selections, fileInfoCalls, objects, releases: () => releases };
}

describe('file path capture', () => {
  it('captures multiple files in multiple inputs with duplicate names and native files getters', async () => {
    const test = fixture([['first.pdf', 'second.pdf'], ['third.pdf', 'fourth.pdf']]);
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields.map((field) => field.value)).toEqual([
      { tag: 'file', files: ['first.pdf', 'second.pdf'].map((name) => ({ ...metadata(name), path: `C:\\uploads\\${name}` })) },
      { tag: 'file', files: ['third.pdf', 'fourth.pdf'].map((name) => ({ ...metadata(name), path: `C:\\uploads\\${name}` })) },
    ]);
    expect(captured.fields.every((field) => field.unavailableReason === undefined)).toBe(true);
    expect(test.snapshot.fields.every((field) => field.unavailableReason === unavailableReason)).toBe(true);
    expect(test.snapshot.fields[0].value).toEqual({ tag: 'file', files: ['first.pdf', 'second.pdf'].map(metadata) });
    expect(test.releases()).toBe(2);
    expect(test.objects.size).toBe(0);
  });

  it('preserves metadata on failure, releases handles, and continues with other inputs', async () => {
    const test = fixture([['first.pdf', 'unavailable.pdf'], ['third.pdf']]);
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields[0].value).toEqual(test.snapshot.fields[0].value);
    expect(captured.fields[0].unavailableReason).toContain('DOM.getFileInfo');
    expect(captured.fields[1].unavailableReason).toBeUndefined();
    expect(captured.fields[1].value).toEqual({ tag: 'file', files: [{ ...metadata('third.pdf'), path: 'C:\\uploads\\third.pdf' }] });
    expect(test.releases()).toBe(2);
    expect(test.objects.size).toBe(0);
  });

  it('does not attach paths to stale metadata when the selection changes before capture', async () => {
    const test = fixture([['first.pdf']]);
    test.selections[0][0] = 'replacement.pdf';
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields[0].value).toEqual(test.snapshot.fields[0].value);
    expect(captured.fields[0].unavailableReason).toContain('selection changed');
    expect(test.fileInfoCalls).toEqual([]);
    expect(test.releases()).toBe(1);
  });

  it('clears the unavailable warning for empty file inputs without using CDP', async () => {
    const test = fixture([[]]);
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields[0].unavailableReason).toBeUndefined();
    expect(test.releases()).toBe(0);
  });

  it('reports a CDP file-access denial with recovery instructions and still releases handles', async () => {
    const test = fixture([['private-name.pdf']]);
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const captured = await captureFilePaths(async (method, params) => {
      if (method === 'DOM.getFileInfo') throw new Error('{"code":-32000,"message":"Not allowed"}');
      return test.cdp(method, params);
    }, test.snapshot, (event, details) => events.push({ event, details }));
    expect(captured.fields[0].unavailableReason).toContain('Allow access to file URLs');
    expect(captured.fields[0].value).toEqual(test.snapshot.fields[0].value);
    expect(events.find(({ event }) => event === 'file.capture.error')?.details).toMatchObject({ fieldIndex: 0, stage: 'DOM.getFileInfo', message: '{"code":-32000,"message":"Not allowed"}' });
    expect(JSON.stringify(events)).not.toContain('private-name.pdf');
    expect(test.releases()).toBe(1);
    expect(test.objects.size).toBe(0);
  });

  it.each([
    ['', 'empty'],
    [undefined, 'missing'],
    ['C:\\fakepath\\private-name.pdf', 'fake'],
    ['/home/private/private-name.pdf', 'unsupported'],
  ])('diagnoses unusable paths without logging them (%s)', async (path, pathStatus) => {
    const test = fixture([['private-name.pdf']]);
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const captured = await captureFilePaths(async (method, params) => method === 'DOM.getFileInfo' ? { path } : test.cdp(method, params), test.snapshot, (event, details) => events.push({ event, details }));
    expect(captured.fields[0].value).toEqual(test.snapshot.fields[0].value);
    expect(captured.fields[0].unavailableReason).toContain('empty, fake, or unsupported');
    expect(events.find(({ event }) => event === 'file.capture.path')?.details).toMatchObject({ fileIndex: 0, pathStatus });
    expect(JSON.stringify(events)).not.toContain('private-name.pdf');
    expect(test.releases()).toBe(1);
  });

  it('redacts local paths in protocol errors', async () => {
    const test = fixture([['private-name.pdf']]);
    const events: unknown[] = [];
    const captured = await captureFilePaths(async (method, params) => {
      if (method === 'DOM.getFileInfo') throw new Error('Cannot read C:\\private\\private-name.pdf');
      return test.cdp(method, params);
    }, test.snapshot, (event, details) => events.push({ event, details }));
    expect(JSON.stringify(events)).not.toContain('private-name.pdf');
    expect(JSON.stringify(captured.fields[0].unavailableReason)).not.toContain('private-name.pdf');
  });

  it.each(['Runtime.evaluate', 'Runtime.getProperties'])('reports JavaScript exceptions at %s', async (stage) => {
    const test = fixture([['first.pdf']]);
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const captured = await captureFilePaths(async (method, params) => method === stage ? { result: {}, exceptionDetails: { text: 'Error' } } : test.cdp(method, params), test.snapshot, (event, details) => events.push({ event, details }));
    expect(captured.fields[0].unavailableReason).toContain(stage);
    expect(events.find(({ event }) => event === 'file.capture.error')?.details).toMatchObject({ stage });
    expect(test.fileInfoCalls).toEqual([]);
    expect(test.releases()).toBe(1);
  });

  it('diagnoses missing file objects separately from an empty path', async () => {
    const test = fixture([['first.pdf']]);
    const captured = await captureFilePaths(async (method, params) => method === 'Runtime.getProperties' ? { result: [{ name: '0', get: { objectId: 'getter' } }] } : test.cdp(method, params), test.snapshot);
    expect(captured.fields[0].unavailableReason).toContain('all selected File objects');
    expect(test.fileInfoCalls).toEqual([]);
  });

  it('logs successful capture without disclosing names or paths', async () => {
    const test = fixture([['private-name.pdf']]);
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    await captureFilePaths(test.cdp, test.snapshot, (event, details) => events.push({ event, details }));
    expect(events.find(({ event }) => event === 'file.capture.complete')?.details).toMatchObject({ fileCount: 1, capturedPathCount: 1 });
    expect(JSON.stringify(events)).not.toContain('private-name.pdf');
    expect(JSON.stringify(events)).not.toContain('uploads');
  });
});
