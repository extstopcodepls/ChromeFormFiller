import { describe, expect, it } from 'vitest';
import { matchesForForm, sameForm, suggestedName } from '../src/matching';
import type { FormIdentity, SavedFilling } from '../src/types';

const form: FormIdentity = { origin: 'https://example.test', pathname: '/signup', formId: 'main', formName: '', actionOrigin: 'https://example.test', actionPath: '/signup', method: 'POST', fingerprint: 'abc' };
const entry = (id: string, fingerprint = 'abc', lastUsedAt?: number): SavedFilling => ({ id, schemaVersion: 1, name: id, form: { ...form, fingerprint }, fields: [], createdAt: 1, updatedAt: Number(id), lastUsedAt });

describe('form matching', () => {
  it('requires exact origin, pathname, and structure', () => {
    expect(sameForm(form, { ...form, origin: 'https://other.test' })).toBe(false);
    expect(sameForm(form, { ...form, pathname: '/other' })).toBe(false);
    expect(sameForm(form, { ...form, fingerprint: 'changed' })).toBe(false);
  });
  it('orders matches by last use and then update time', () => {
    expect(matchesForForm([entry('1', 'abc', 2), entry('3', 'abc', 4), entry('2', 'abc', 4), entry('9', 'different')], form).map((item) => item.id)).toEqual(['3', '2', '1']);
  });
  it('creates a useful default name', () => { expect(suggestedName(form, 3)).toBe('example.test/signup (3 fields)'); });
});
