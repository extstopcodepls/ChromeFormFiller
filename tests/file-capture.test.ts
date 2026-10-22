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
    expect(captured.fields[0]).toEqual(test.snapshot.fields[0]);
    expect(captured.fields[1].unavailableReason).toBeUndefined();
    expect(captured.fields[1].value).toEqual({ tag: 'file', files: [{ ...metadata('third.pdf'), path: 'C:\\uploads\\third.pdf' }] });
    expect(test.releases()).toBe(2);
    expect(test.objects.size).toBe(0);
  });

  it('does not attach paths to stale metadata when the selection changes before capture', async () => {
    const test = fixture([['first.pdf']]);
    test.selections[0][0] = 'replacement.pdf';
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields[0]).toEqual(test.snapshot.fields[0]);
    expect(test.fileInfoCalls).toEqual([]);
    expect(test.releases()).toBe(1);
  });

  it('clears the unavailable warning for empty file inputs without using CDP', async () => {
    const test = fixture([[]]);
    const captured = await captureFilePaths(test.cdp, test.snapshot);
    expect(captured.fields[0].unavailableReason).toBeUndefined();
    expect(test.releases()).toBe(0);
  });
});
