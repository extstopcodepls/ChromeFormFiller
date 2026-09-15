import type { Envelope, VaultMeta } from './crypto';
import type { PendingDraft, SavedFilling } from './types';

export interface Config { enabledOrigins: string[]; ignoredForms: string[]; debug: boolean; }
const defaultConfig: Config = { enabledOrigins: [], ignoredForms: [], debug: false };

export async function getLocal<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}
export async function setLocal(values: Record<string, unknown>): Promise<void> { await chrome.storage.local.set(values); }
export async function removeLocal(keys: string | string[]): Promise<void> { await chrome.storage.local.remove(keys); }
export async function getSession<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.session.get(key);
  return result[key] as T | undefined;
}
export async function setSession(values: Record<string, unknown>): Promise<void> { await chrome.storage.session.set(values); }
export async function clearSession(keys: string | string[]): Promise<void> { await chrome.storage.session.remove(keys); }

export async function getConfig(): Promise<Config> { return { ...defaultConfig, ...(await getLocal<Config>('config')) }; }
export async function setConfig(config: Config): Promise<void> { await setLocal({ config }); }
export async function getVaultMeta(): Promise<VaultMeta | undefined> { return getLocal<VaultMeta>('vaultMeta'); }
export async function setVaultMeta(meta: VaultMeta): Promise<void> { await setLocal({ vaultMeta: meta }); }

export async function getEntryIds(): Promise<string[]> { return (await getLocal<string[]>('entryIds')) ?? []; }
export async function setEntryIds(ids: string[]): Promise<void> { await setLocal({ entryIds: ids }); }
export async function getEntryEnvelope(id: string): Promise<Envelope | undefined> { return getLocal<Envelope>(`entry:${id}`); }
export async function setEntryEnvelope(id: string, envelope: Envelope): Promise<void> { await setLocal({ [`entry:${id}`]: envelope }); }
export async function deleteEntryEnvelope(id: string): Promise<void> { await removeLocal(`entry:${id}`); }

export async function getDraftIds(): Promise<string[]> { return (await getSession<string[]>('draftIds')) ?? []; }
export async function setDraftIds(ids: string[]): Promise<void> { await setSession({ draftIds: ids }); }
export async function getDraftEnvelope(id: string): Promise<Envelope | undefined> { return getSession<Envelope>(`draft:${id}`); }
export async function setDraftEnvelope(id: string, envelope: Envelope): Promise<void> { await setSession({ [`draft:${id}`]: envelope }); }
export async function deleteDraftEnvelope(id: string): Promise<void> { await clearSession(`draft:${id}`); }
