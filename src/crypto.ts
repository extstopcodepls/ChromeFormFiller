import type { SavedFilling, PendingDraft } from './types';

const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const source = (value: Uint8Array): BufferSource => value as unknown as BufferSource;

export interface VaultMeta { version: 1; salt: string; wrappedKey: string; wrapIv: string; }
export interface Envelope { version: 1; recordId: string; iv: string; ciphertext: string; }

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result = '';
  for (const byte of array) result += String.fromCharCode(byte);
  return btoa(result);
}
function bytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: source(salt), iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const aad = (id: string) => enc.encode(`chrome-form-filler:v1:${id}`);

export async function createVault(passphrase: string): Promise<{ meta: VaultMeta; dataKey: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const kek = await deriveKey(passphrase, salt);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(wrapIv), additionalData: source(aad('vault-key')) }, kek, source(dataKey));
  return { meta: { version: 1, salt: b64(salt), wrappedKey: b64(wrappedKey), wrapIv: b64(wrapIv) }, dataKey };
}

export async function unlockVault(passphrase: string, meta: VaultMeta): Promise<Uint8Array> {
  const kek = await deriveKey(passphrase, bytes(meta.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(bytes(meta.wrapIv)), additionalData: source(aad('vault-key')) }, kek, source(bytes(meta.wrappedKey)));
  if (plain.byteLength !== 32) throw new Error('The vault key is invalid');
  return new Uint8Array(plain);
}

async function dataCryptoKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', source(raw), { name: 'AES-GCM' }, false, usages);
}

export async function encryptRecord<T extends SavedFilling | PendingDraft>(rawKey: Uint8Array, record: T): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await dataCryptoKey(rawKey, ['encrypt']);
  const plaintext = enc.encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(iv), additionalData: source(aad(record.id)) }, key, source(plaintext));
  return { version: 1, recordId: record.id, iv: b64(iv), ciphertext: b64(ciphertext) };
}

export async function decryptRecord<T extends SavedFilling | PendingDraft>(rawKey: Uint8Array, envelope: Envelope): Promise<T> {
  if (envelope.version !== 1 || !envelope.recordId) throw new Error('Unsupported vault record');
  const key = await dataCryptoKey(rawKey, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(bytes(envelope.iv)), additionalData: source(aad(envelope.recordId)) }, key, source(bytes(envelope.ciphertext)));
  const record = JSON.parse(dec.decode(plaintext)) as T;
  if (!record || record.id !== envelope.recordId) throw new Error('Vault record identity mismatch');
  return record;
}

export function toSessionKey(raw: Uint8Array): string { return b64(raw); }
export function fromSessionKey(value: string): Uint8Array { return bytes(value); }
