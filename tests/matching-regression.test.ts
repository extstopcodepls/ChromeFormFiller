import { describe, expect, it } from 'vitest';
import { explainFieldMatch, explainSnapshotMatch, fieldMatchKeys, matchesForForm, matchesForSnapshot } from '../src/matching';
import type { FormIdentity, SavedFilling } from '../src/types';

const form: FormIdentity = { origin: 'https://example.test', pathname: '/form', formId: 'checkout', formName: '', actionOrigin: 'https://example.test', actionPath: '/form', method: 'POST', fingerprint: 'stable-editable-structure', formIndex: 0 };
const saved: SavedFilling = { id: 'saved', schemaVersion: 1, name: 'Saved', form, fields: [], createdAt: 1, updatedAt: 1 };

describe('matching regression coverage', () => {
  it('does not let unrelated form metadata participate in exact matching', () => {
    const current = { ...form, formId: 'checkout-renamed', formName: 'new-name', actionPath: '/form?csrf=rotated', fingerprint: form.fingerprint, formIndex: 0 };
    expect(matchesForForm([saved], current).map((entry) => entry.id)).toEqual(['saved']);
  });
  it('separates identical forms by their stable document position', () => {
    expect(matchesForForm([saved], { ...form, formId: 'other', formIndex: 1 })).toEqual([]);
    expect(matchesForForm([saved], { ...form, formId: 'other', formIndex: 0 })).toHaveLength(1);
  });
  it('keeps a saved filling when generated field ids or names change', () => {
    const current = {
      form: { ...form, fingerprint: 'changed-after-rerender' },
      fields: [
        { descriptor: { key: 'text|new-name|new-id|0', kind: 'text' as const, name: 'new-name', id: 'new-id', label: 'Name', index: 0, typeSignature: 'text|new-name|new-id' }, value: { tag: 'text' as const, value: '' }, included: true },
      ],
      capturedAt: 1, revision: 0, completeness: 'complete' as const,
    };
    const withField = { ...saved, fields: [{ descriptor: { key: 'text|name|old-id|0', kind: 'text' as const, name: 'name', id: 'old-id', label: 'Name', index: 0, typeSignature: 'text|name|old-id' }, value: { tag: 'text' as const, value: 'saved' }, included: true }] };
    expect(matchesForSnapshot([withField], current).map((entry) => entry.id)).toEqual(['saved']);
    expect(explainSnapshotMatch(withField, current)).toMatchObject({
      matched: true,
      form: { fingerprint: false, metadataCompatible: true },
      structure: { used: true, compatible: true, savedFieldCount: 1, currentFieldCount: 1 },
    });
  });
  it('serializes and searches every element key independently', () => {
    const savedField = { descriptor: { key: 'legacy-combined-value-must-not-be-used', kind: 'text' as const, name: 'account', id: 'old-id', label: 'Account name', index: 0, matchKeys: [{ strategy: 'id' as const, value: 'old-id' }, { strategy: 'name' as const, value: 'account' }, { strategy: 'label' as const, value: 'Account name' }, { strategy: 'position' as const, value: 0 }] }, value: { tag: 'text' as const, value: 'saved' }, included: true };
    const currentFields = [{ descriptor: { key: 'current', kind: 'text' as const, name: 'account', id: 'new-id', label: 'New label', index: 4, matchKeys: [{ strategy: 'id' as const, value: 'new-id' }, { strategy: 'name' as const, value: 'account' }, { strategy: 'label' as const, value: 'New label' }, { strategy: 'position' as const, value: 4 }] }, value: { tag: 'text' as const, value: '' }, included: true }];
    expect(fieldMatchKeys(savedField.descriptor)).toEqual(savedField.descriptor.matchKeys);
    const trace = explainFieldMatch(savedField, currentFields);
    expect(trace.decision).toBe('name');
    expect(trace.attempts.map((attempt) => [attempt.strategy, attempt.compatibleMatches])).toEqual([
      ['id', 0], ['name', 1], ['label', 0], ['position', 0],
    ]);
  });
  it('records every key attempt even when the id already matches', () => {
    const field = { descriptor: { key: 'field-0', kind: 'text' as const, name: 'account', id: 'account-id', label: 'Account', index: 0 }, value: { tag: 'text' as const, value: '' }, included: true };
    const trace = explainFieldMatch(field, [{ ...field, descriptor: { ...field.descriptor } }]);
    expect(trace.decision).toBe('id');
    expect(trace.attempts.map((attempt) => attempt.strategy)).toEqual(['id', 'name', 'label', 'position']);
    expect(trace.attempts.every((attempt) => attempt.unique)).toBe(true);
  });
  it('does not resolve an ambiguous independent key by choosing the first element', () => {
    const savedField = { descriptor: { key: 'field', kind: 'text' as const, name: 'duplicate', id: '', label: '', index: -1 }, value: { tag: 'text' as const, value: '' }, included: true };
    const currentFields = [0, 1].map((index) => ({ descriptor: { key: `current-${index}`, kind: 'text' as const, name: 'duplicate', id: '', label: '', index }, value: { tag: 'text' as const, value: '' }, included: true }));
    const trace = explainFieldMatch(savedField, currentFields);
    expect(trace.decision).toBe('missing');
    expect(trace.attempts).toEqual([expect.objectContaining({ strategy: 'name', compatibleMatches: 2, unique: false })]);
    expect(matchesForSnapshot([{ ...saved, fields: [savedField] }], { form: { ...form, fingerprint: 'changed' }, fields: currentFields, capturedAt: 1, revision: 0, completeness: 'complete' })).toEqual([]);
  });
  it('keeps a saved filling when the page adds another eligible control', () => {
    const savedWithField = { ...saved, fields: [{ descriptor: { key: 'email|email|email|0', kind: 'email' as const, name: 'email', id: 'email', label: 'Email', index: 0, typeSignature: 'email|email|email' }, value: { tag: 'text' as const, value: 'saved@example.test' }, included: true }] };
    const current = {
      form: { ...form, fingerprint: 'changed-with-extra-control' },
      fields: [
        { descriptor: { key: 'text|promo|promo|0', kind: 'text' as const, name: 'promo', id: 'promo', label: 'Promo code', index: 0, typeSignature: 'text|promo|promo' }, value: { tag: 'text' as const, value: '' }, included: true },
        { descriptor: { key: 'text|email|generated|1', kind: 'text' as const, name: 'email', id: 'generated', label: 'Email', index: 1, typeSignature: 'text|email|generated' }, value: { tag: 'text' as const, value: '' }, included: true },
      ],
      capturedAt: 1, revision: 0, completeness: 'complete' as const,
    };
    expect(matchesForSnapshot([savedWithField], current).map((entry) => entry.id)).toEqual(['saved']);
  });
  it('treats text-like HTML type changes as replay-compatible', () => {
    const savedWithField = { ...saved, fields: [{ descriptor: { key: 'email|email|email|0', kind: 'email' as const, name: 'email', id: 'email', label: 'Email', index: 0, typeSignature: 'email|email|email' }, value: { tag: 'text' as const, value: 'saved@example.test' }, included: true }] };
    const current = { form: { ...form, fingerprint: 'changed-type' }, fields: [{ descriptor: { key: 'text|email|email|0', kind: 'text' as const, name: 'email', id: 'email', label: 'Email', index: 0, typeSignature: 'text|email|email' }, value: { tag: 'text' as const, value: '' }, included: true }], capturedAt: 1, revision: 0, completeness: 'complete' as const };
    expect(matchesForSnapshot([savedWithField], current)).toHaveLength(1);
  });
  it('explains the exact field that makes a structural fallback fail', () => {
    const withField = { ...saved, fields: [{ descriptor: { key: 'text|name|old-id|0', kind: 'text' as const, name: 'name', id: 'old-id', label: 'Name', index: 0, typeSignature: 'text|name|old-id' }, value: { tag: 'text' as const, value: 'saved' }, included: true }] };
    const current = { form: { ...form, fingerprint: 'changed' }, fields: [{ descriptor: { key: 'checkbox|name|new-id|0', kind: 'checkbox' as const, name: 'name', id: 'new-id', label: 'Name', index: 0, typeSignature: 'checkbox|name|new-id' }, value: { tag: 'boolean' as const, value: false }, included: true }], capturedAt: 1, revision: 0, completeness: 'complete' as const };
    const trace = explainSnapshotMatch(withField, current);
    expect(trace.matched).toBe(false);
    expect(trace.structure.fields[0]).toMatchObject({ savedFieldIndex: 0, savedKind: 'text', matched: false, decision: 'missing' });
    expect(trace.structure.fields[0].attempts).toHaveLength(4);
  });
});
