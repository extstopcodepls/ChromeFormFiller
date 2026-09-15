import { describe, expect, it } from 'vitest';
import { createVault, decryptRecord, encryptRecord, unlockVault } from '../src/crypto';
import type { SavedFilling } from '../src/types';

const record: SavedFilling = { id: 'entry-1', schemaVersion: 1, name: 'Example', form: { origin: 'https://example.test', pathname: '/', formId: '', formName: '', actionOrigin: 'https://example.test', actionPath: '/', method: 'GET', fingerprint: 'a' }, fields: [], createdAt: 1, updatedAt: 1 };

describe('vault encryption', () => {
  it('round trips records and rejects a wrong passphrase', async () => {
    const created = await createVault('correct horse battery staple');
    const envelope = await encryptRecord(created.dataKey, record);
    await expect(decryptRecord(await unlockVault('correct horse battery staple', created.meta), envelope)).resolves.toEqual(record);
    await expect(unlockVault('wrong passphrase', created.meta)).rejects.toThrow();
  }, 20_000);
  it('uses a fresh IV for each record encryption', async () => {
    const created = await createVault('correct horse battery staple');
    const first = await encryptRecord(created.dataKey, record); const second = await encryptRecord(created.dataKey, record);
    expect(first.iv).not.toBe(second.iv); expect(first.ciphertext).not.toBe(second.ciphertext);
  }, 20_000);
});
