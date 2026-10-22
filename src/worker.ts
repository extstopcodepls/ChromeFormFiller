import type { Message, Response } from './messages';
import { isMessage } from './messages';
import { createVault, decryptRecord, encryptRecord, fromSessionKey, toSessionKey, unlockVault, type Envelope, type VaultMeta } from './crypto';
import { deleteDraftEnvelope, deleteEntryEnvelope, getConfig, getDraftEnvelope, getDraftIds, getEntryEnvelope, getEntryIds, getSession, getVaultMeta, removeLocal, setConfig, setDraftEnvelope, setDraftIds, setEntryEnvelope, setEntryIds, setSession, setVaultMeta } from './storage';
import { explainSnapshotMatch, fieldMatchKeys, matchesForForm, matchesForSnapshot, suggestedName, sameForm } from './matching';
import { normalizeWaitAfterFillMs, normalizeWaitAfterFillOverrideMs } from './delay';
import { captureFilePaths, replay } from './replay';
import type { FieldValue, FormSnapshot, PendingDraft, SavedFilling, SiteStatus } from './types';

const SESSION_KEY = 'sessionDataKey';
const ACTIVITY_KEY = 'activityAt';
const LOCK_AFTER = 30 * 60 * 1000;
const DRAFT_TTL = 15 * 60 * 1000;
const MAX_CAPTURE = 1024 * 1024;
const PENDING_ENABLE_KEY = 'pendingEnableOrigin';
let dataKey: Uint8Array | undefined;
const cancelTabs = new Set<number>();
const queues = new Map<number, Promise<unknown>>();
const originRegistrations = new Map<string, Promise<void>>();

function originFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined; } catch { return undefined; }
}
function permissionPattern(origin: string): string { const parsed = new URL(origin); return `${parsed.protocol}//${parsed.hostname}/*`; }
function formKey(form: FormSnapshot['form']): string { return `${form.origin}|${form.pathname}|${form.formId}|${form.formName}|${form.formIndex ?? ''}|${form.fingerprint}`; }
function fieldSummary(field: SavedFilling['fields'][number]): string { const value = field.value; if (value.tag === 'file') return value.files.map((file) => file.name).join(', ') || '(empty file selection)'; if (value.tag === 'options') return value.values.join(', ') || '(empty selection)'; if (value.tag === 'boolean') return String(value.value); if (value.tag === 'radio') return value.value ?? '(none selected)'; return value.value || '(empty)'; }
function valueMatchesKind(kind: SavedFilling['fields'][number]['descriptor']['kind'], value: FieldValue): boolean {
  if (kind === 'checkbox') return value.tag === 'boolean';
  if (kind === 'radio') return value.tag === 'radio';
  if (kind === 'select-one' || kind === 'select-multiple') return value.tag === 'options';
  if (kind === 'file') return value.tag === 'file';
  return value.tag === 'text';
}
function fieldWithWait(field: SavedFilling['fields'][number], waits: Record<string, number | null> | undefined): SavedFilling['fields'][number] {
  if (!waits || !Object.prototype.hasOwnProperty.call(waits, field.descriptor.key)) return field;
  const waitAfterFillMs = normalizeWaitAfterFillOverrideMs(waits[field.descriptor.key]);
  return waitAfterFillMs === undefined ? { ...field, waitAfterFillMs: undefined } : { ...field, waitAfterFillMs };
}
function serializedFieldSummary(field: SavedFilling['fields'][number], fieldIndex: number): Record<string, unknown> { return { fieldIndex, resultKey: field.descriptor.key, kind: field.descriptor.kind, included: field.included, matchKeys: fieldMatchKeys(field.descriptor) }; }
async function enabled(origin: string): Promise<boolean> { return (await getConfig()).enabledOrigins.includes(origin); }
async function touch(): Promise<void> { const now = Date.now(); await setSession({ [ACTIVITY_KEY]: now }); }
async function unlocked(): Promise<boolean> {
  const last = await getSession<number>(ACTIVITY_KEY);
  if (dataKey && last && Date.now() - last < LOCK_AFTER) return true;
  if (dataKey) await lockVault();
  return false;
}
async function requireKey(): Promise<Uint8Array> { if (!(await unlocked()) || !dataKey) throw new Error('Unlock the vault to save or fill.'); await touch(); return dataKey; }
async function allEntries(key: Uint8Array): Promise<SavedFilling[]> {
  const ids = await getEntryIds(); const entries: SavedFilling[] = [];
  for (const id of ids) { const envelope = await getEntryEnvelope(id); if (!envelope) continue; try { entries.push(await decryptRecord<SavedFilling>(key, envelope)); } catch { /* Corrupt records are skipped and remain recoverable for deletion. */ } }
  return entries;
}
async function pendingDrafts(key: Uint8Array): Promise<PendingDraft[]> {
  const ids = await getDraftIds(); const keep: string[] = []; const drafts: PendingDraft[] = [];
  for (const id of ids) { const envelope = await getDraftEnvelope(id); if (!envelope) continue; try { const draft = await decryptRecord<PendingDraft>(key, envelope); if (draft.expiresAt > Date.now()) { keep.push(id); drafts.push(draft); } else await deleteDraftEnvelope(id); } catch { await deleteDraftEnvelope(id); } }
  if (keep.length !== ids.length) await setDraftIds(keep); return drafts;
}
async function pendingSubmissionForTab(key: Uint8Array, tabId: number | undefined, origin: string | undefined): Promise<PendingDraft | undefined> {
  if (tabId === undefined) return undefined;
  const drafts = await pendingDrafts(key);
  return drafts.find((draft) => draft.submissionObserved && draft.sourceTabId === tabId && (!origin || draft.form.origin === origin));
}
async function saveDraft(snapshot: FormSnapshot, tabId: number | undefined, submissionObserved: boolean): Promise<string> {
  const key = await requireKey();
  const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
  if (encoded.byteLength > MAX_CAPTURE) throw new Error('This form snapshot is larger than the 1 MiB limit.');
  const now = Date.now(); const draft: PendingDraft = { ...snapshot, id: crypto.randomUUID(), sourceTabId: tabId, submissionObserved, expiresAt: now + DRAFT_TTL };
  const ids = await getDraftIds(); const old = await pendingDrafts(key);
  const nextIds = [draft.id, ...ids.filter((id) => old.some((item) => item.id === id))].slice(0, 20);
  for (const id of ids.slice(19)) await deleteDraftEnvelope(id);
  await setDraftEnvelope(draft.id, await encryptRecord(key, draft)); await setDraftIds(nextIds); return draft.id;
}
async function deleteDraftsForOrigin(key: Uint8Array, origin: string): Promise<void> { const drafts = await pendingDrafts(key); const remove = drafts.filter((draft) => draft.form.origin === origin); for (const draft of remove) await deleteDraftEnvelope(draft.id); await setDraftIds((await getDraftIds()).filter((id) => !remove.some((draft) => draft.id === id))); }
async function getSiteStatus(tabId?: number, url?: string): Promise<SiteStatus> {
  const origin = originFromUrl(url) ?? '';
  const config = await getConfig();
  const permission = origin ? await chrome.permissions.contains({ origins: [permissionPattern(origin)] }) : false;
  const isUnlocked = await unlocked();
  return { origin, enabled: origin ? config.enabledOrigins.includes(origin) : false, permission, unlocked: isUnlocked, pendingCount: isUnlocked && dataKey ? (await pendingDrafts(dataKey)).length : 0, debug: config.debug };
}
async function debugLog(event: string, details: Record<string, unknown> = {}): Promise<void> { if ((await getConfig()).debug) console.info('[Form Filler][worker]', event, details); }
async function broadcast(message: unknown): Promise<void> { const tabs = await chrome.tabs.query({}); await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)])); }

async function registerOrigin(origin: string): Promise<void> {
  const pending = originRegistrations.get(origin);
  if (pending) return pending;
  const registration = registerOriginOnce(origin);
  originRegistrations.set(origin, registration);
  try { await registration; } finally { if (originRegistrations.get(origin) === registration) originRegistrations.delete(origin); }
}
async function registerOriginOnce(origin: string): Promise<void> {
  const id = `form-filler-${btoa(origin).replaceAll('=', '').replaceAll('/', '_').replaceAll('+', '-')}`;
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (scripts.length) return;
  await chrome.scripting.registerContentScripts([{ id, matches: [permissionPattern(origin)], js: ['content.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true }]);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id !== undefined && originFromUrl(tab.url) === origin) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined);
}
async function unregisterOrigin(origin: string): Promise<void> { const id = `form-filler-${btoa(origin).replaceAll('=', '').replaceAll('/', '_').replaceAll('+', '-')}`; await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined); }
async function reconcile(): Promise<void> { for (const origin of (await getConfig()).enabledOrigins) if (await chrome.permissions.contains({ origins: [permissionPattern(origin)] })) await registerOrigin(origin); }
async function activateOrigin(origin: string): Promise<void> { const config = await getConfig(); if (!config.enabledOrigins.includes(origin)) { config.enabledOrigins.push(origin); await setConfig(config); } await registerOrigin(origin); await chrome.storage.session.remove(PENDING_ENABLE_KEY).catch(() => undefined); }
async function finishPendingEnable(addedPatterns: string[] = []): Promise<void> { const pending = await getSession<string>(PENDING_ENABLE_KEY); if (!pending || (addedPatterns.length && !addedPatterns.includes(permissionPattern(pending)))) return; if (await chrome.permissions.contains({ origins: [permissionPattern(pending)] })) await activateOrigin(pending); }

async function withTabQueue<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(tabId, current.finally(() => { if (queues.get(tabId) === current) queues.delete(tabId); }));
  return current;
}
async function enableDomReplay(cdp: (method: string, params?: Record<string, unknown>) => Promise<any>): Promise<void> {
  await cdp('DOM.enable');
  await cdp('Runtime.enable');
  // DOM.enable turns on the agent, but does not necessarily populate the
  // frontend node-id space. Without a document request, DOM.requestNode can
  // return the sentinel nodeId 0 for an otherwise valid Runtime object.
  await cdp('DOM.getDocument', { depth: 0 });
}
async function cdpReplay(tabId: number, filling: SavedFilling, currentForm: SavedFilling['form']): Promise<ReturnType<typeof replay>> {
  const debug = (await getConfig()).debug; const log = debug ? (event: string, details: Record<string, unknown> = {}) => { console.info('[Form Filler][replay]', event, details); } : undefined;
  cancelTabs.delete(tabId); log?.('debugger.attach', { tabId }); await chrome.debugger.attach({ tabId }, '1.3');
  const cdp = (method: string, params?: Record<string, unknown>) => chrome.debugger.sendCommand({ tabId }, method, params);
  try { await enableDomReplay(cdp); const result = await replay(cdp, { ...filling, form: currentForm }, () => cancelTabs.has(tabId), log, debug); log?.('replay.complete', { status: result.status, fieldCount: result.fields.length, failedCount: result.fields.filter((field) => ['missing', 'manual', 'failed'].includes(field.status)).length }); return result; }
  catch (error) { log?.('replay.error', { message: error instanceof Error ? error.message : 'Unknown debugger error' }); throw error; }
  finally { await chrome.debugger.detach({ tabId }).catch(() => undefined); log?.('debugger.detach', { tabId }); }
}
async function captureSnapshot(tabId: number | undefined, snapshot: FormSnapshot): Promise<FormSnapshot> {
  if (tabId === undefined || !snapshot.fields.some((field) => field.descriptor.kind === 'file' && field.value.tag === 'file' && field.value.files.length)) return snapshot;
  await chrome.debugger.attach({ tabId }, '1.3');
  const cdp = (method: string, params?: Record<string, unknown>) => chrome.debugger.sendCommand({ tabId }, method, params);
  try { await enableDomReplay(cdp); return await captureFilePaths(cdp, snapshot); }
  finally { await chrome.debugger.detach({ tabId }).catch(() => undefined); }
}

const workerReady = (async () => {
  const stored = await getSession<string>(SESSION_KEY);
  if (stored) dataKey = fromSessionKey(stored);
  await reconcile();
  await finishPendingEnable();
})();

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<Response> {
  await workerReady;
  const tabId = sender.tab?.id; const tabUrl = sender.tab?.url ?? ('tabUrl' in message ? message.tabUrl : undefined); const senderOrigin = originFromUrl(tabUrl);
  if (message.type === 'GET_SITE_STATUS') return { ok: true, requestId: message.requestId, status: await getSiteStatus(tabId, tabUrl) };
  if (message.type === 'SET_DEBUG') { const config = await getConfig(); config.debug = message.enabled; await setConfig(config); await setSession({ debug: message.enabled }); await broadcast({ type: 'DEBUG_STATE', enabled: message.enabled }); console.info('[Form Filler][worker]', 'debug state changed', { enabled: message.enabled }); return { ok: true, requestId: message.requestId, status: await getSiteStatus(tabId, tabUrl) }; }
  if (message.type === 'ENABLE_SITE_INTENT') { if (!senderOrigin) throw new Error('Only ordinary HTTP and HTTPS pages can be enabled.'); await setSession({ [PENDING_ENABLE_KEY]: senderOrigin }); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'CANCEL_ENABLE_SITE_INTENT') { await chrome.storage.session.remove(PENDING_ENABLE_KEY); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'ENABLE_SITE') {
    if (!senderOrigin) throw new Error('Only ordinary HTTP and HTTPS pages can be enabled.');
    const granted = message.permissionGranted ? await chrome.permissions.contains({ origins: [permissionPattern(senderOrigin)] }) : await chrome.permissions.request({ origins: [permissionPattern(senderOrigin)] }); if (!granted) throw new Error('Site permission was not granted.');
    await activateOrigin(senderOrigin); return { ok: true, status: await getSiteStatus(tabId, tabUrl) };
  }
  if (message.type === 'DISABLE_SITE') {
    if (!senderOrigin) throw new Error('No enabled site is active.'); const config = await getConfig(); config.enabledOrigins = config.enabledOrigins.filter((item) => item !== senderOrigin); await setConfig(config); if (dataKey && await unlocked()) await deleteDraftsForOrigin(dataKey, senderOrigin); await unregisterOrigin(senderOrigin); return { ok: true, status: await getSiteStatus(tabId, tabUrl) };
  }
  if (message.type === 'UNLOCK_VAULT') {
    if (!message.passphrase || message.passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    const existing = await getVaultMeta(); let raw: Uint8Array; if (!existing) { const created = await createVault(message.passphrase); await setVaultMeta(created.meta); raw = created.dataKey; } else raw = await unlockVault(message.passphrase, existing);
    dataKey = raw; await setSession({ [SESSION_KEY]: toSessionKey(raw), [ACTIVITY_KEY]: Date.now() }); await broadcast({ type: 'VAULT_STATE', unlocked: true }); return { ok: true, message: 'Vault unlocked.' };
  }
  if (message.type === 'LOCK_VAULT') { await lockVault(); return { ok: true, message: 'Vault locked.' }; }
  if (message.type === 'OPEN_LIBRARY') { await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html${message.draftId ? `?draft=${encodeURIComponent(message.draftId)}` : ''}`) }); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'CANCEL_FILL') { if (message.tabId !== undefined) cancelTabs.add(message.tabId); return { ok: true, requestId: message.requestId }; }
  const key = await requireKey();
  if (message.type === 'GET_PENDING_SUBMISSION') { const draft = await pendingSubmissionForTab(key, tabId, message.origin ?? senderOrigin); return { ok: true, requestId: message.requestId, draftId: draft?.id, pendingForm: draft?.form }; }
  if (message.type === 'LIST_MATCHES') { if (sender.tab && (senderOrigin !== message.form.origin || !(await enabled(message.form.origin)))) throw new Error('This site is not authorized.'); const candidates = await allEntries(key); const current = message.fields ? { form: message.form, fields: message.fields, capturedAt: 0, revision: 0, completeness: 'complete' as const } : undefined; const matches = current ? matchesForSnapshot(candidates, current) : matchesForForm(candidates, message.form); if (current) { for (const candidate of candidates) await debugLog('match.candidate', { tabId, entryId: candidate.id, entryName: candidate.name, ...explainSnapshotMatch(candidate, current) }); } await debugLog('matches.listed', { tabId, formIndex: message.form.formIndex, fingerprint: message.form.fingerprint, candidateCount: candidates.length, count: matches.length, matchedEntryIds: matches.map((entry) => entry.id) }); return { ok: true, requestId: message.requestId, matches: matches.map((entry) => ({ id: entry.id, name: entry.name, lastUsedAt: entry.lastUsedAt, updatedAt: entry.updatedAt, fieldCount: entry.fields.filter((field) => field.included).length, preview: entry.fields.filter((field) => field.included).map((field) => ({ key: field.descriptor.key, label: field.descriptor.label || field.descriptor.name || field.descriptor.kind, kind: field.descriptor.kind, id: field.descriptor.id, name: field.descriptor.name, index: field.descriptor.index, matchKeys: fieldMatchKeys(field.descriptor), value: fieldSummary(field) })) })) }; }
  if (message.type === 'CAPTURE_FORM') { if (sender.tab && (senderOrigin !== message.form.form.origin || !(await enabled(message.form.form.origin)))) throw new Error('This site is not authorized.'); await debugLog('capture.requested', { tabId, formIndex: message.form.form.formIndex, fieldCount: message.form.fields.length, serializedFields: message.form.fields.map(serializedFieldSummary) }); const captured = tabId === undefined ? message.form : await withTabQueue(tabId, () => captureSnapshot(tabId, message.form)); const draftId = await saveDraft(captured, tabId, false); await debugLog('capture.completed', { tabId, formIndex: captured.form.formIndex, fieldCount: captured.fields.length, serializedFields: captured.fields.map(serializedFieldSummary) }); return { ok: true, requestId: message.requestId, draftId }; }
  if (message.type === 'SUBMISSION_OBSERVED') { if (sender.tab && (senderOrigin !== message.form.form.origin || !(await enabled(message.form.form.origin)))) throw new Error('This site is not authorized.'); await debugLog('submission.detected', { tabId, formIndex: message.form.form.formIndex, fieldCount: message.form.fields.length, serializedFields: message.form.fields.map(serializedFieldSummary) }); const config = await getConfig(); if (config.ignoredForms.includes(formKey(message.form.form))) { await debugLog('submission.ignored', { tabId, formIndex: message.form.form.formIndex }); return { ok: true, requestId: message.requestId, message: 'This form is ignored.' }; } const captured = tabId === undefined ? message.form : await withTabQueue(tabId, () => captureSnapshot(tabId, message.form)); const draftId = await saveDraft(captured, tabId, true); if (tabId !== undefined) await chrome.action.setBadgeText({ tabId, text: '?' }); await chrome.action.setBadgeBackgroundColor({ color: '#d97706' }).catch(() => undefined); await debugLog('submission.draft-created', { tabId, formIndex: captured.form.formIndex, serializedFields: captured.fields.map(serializedFieldSummary) }); return { ok: true, requestId: message.requestId, draftId }; }
  if (message.type === 'LIST_LIBRARY') return { ok: true, requestId: message.requestId, fillings: await allEntries(key), drafts: await pendingDrafts(key) };
  if (message.type === 'GET_DRAFT') { const envelope = await getDraftEnvelope(message.id); if (!envelope) throw new Error('Draft expired or is no longer available.'); return { ok: true, requestId: message.requestId, draft: await decryptRecord<PendingDraft>(key, envelope) }; }
  if (message.type === 'DISMISS_DRAFT') { const envelope = await getDraftEnvelope(message.id); const existing = envelope ? await decryptRecord<PendingDraft>(key, envelope).catch(() => undefined) : undefined; await deleteDraftEnvelope(message.id); await setDraftIds((await getDraftIds()).filter((id) => id !== message.id)); if (existing?.sourceTabId !== undefined) await chrome.action.setBadgeText({ tabId: existing.sourceTabId, text: '' }); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'IGNORE_FORM') { const config = await getConfig(); const ignoredKey = formKey(message.form); if (!config.ignoredForms.includes(ignoredKey)) config.ignoredForms.push(ignoredKey); await setConfig(config); const drafts = await pendingDrafts(key); for (const item of drafts.filter((candidate) => formKey(candidate.form) === ignoredKey)) await deleteDraftEnvelope(item.id); await setDraftIds((await getDraftIds()).filter((id) => !drafts.some((item) => item.id === id && formKey(item.form) === ignoredKey))); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'SAVE_FILLING') {
    let draft: PendingDraft | undefined; if (message.draftId) { const envelope = await getDraftEnvelope(message.draftId); if (!envelope) throw new Error('Draft expired.'); draft = await decryptRecord<PendingDraft>(key, envelope); }
    if (!draft && !message.filling) throw new Error('Nothing to save.');
    if (message.filling) throw new Error('Direct filling payloads are not accepted. Save a reviewed draft instead.');
    const now = Date.now(); const filling: SavedFilling = { id: crypto.randomUUID(), schemaVersion: 1, name: message.name?.trim() || suggestedName(draft!.form, draft!.fields.length), form: draft!.form, fields: draft!.fields.map((field) => fieldWithWait({ ...field, included: !(message.excludedKeys ?? []).includes(field.descriptor.key) && field.included }, message.fieldWaitAfterFillMs)), createdAt: now, updatedAt: now, waitAfterFillMs: normalizeWaitAfterFillMs(message.waitAfterFillMs) };
    if (!filling.name) throw new Error('Enter a name.');
    await setEntryEnvelope(filling.id, await encryptRecord(key, filling)); const ids = await getEntryIds(); if (!ids.includes(filling.id)) await setEntryIds([filling.id, ...ids]);
    if (draft?.sourceTabId !== undefined) await chrome.action.setBadgeText({ tabId: draft.sourceTabId, text: '' });
    if (message.draftId) { await deleteDraftEnvelope(message.draftId); await setDraftIds((await getDraftIds()).filter((id) => id !== message.draftId)); }
    return { ok: true, requestId: message.requestId, filling };
  }
  if (message.type === 'UPDATE_FILLING') { const envelope = await getEntryEnvelope(message.id); if (!envelope) throw new Error('Saved filling not found.'); const old = await decryptRecord<SavedFilling>(key, envelope); const updatedFields = old.fields.map((field) => { const candidate = message.fieldValues?.[field.descriptor.key]; return fieldWithWait({ ...field, value: candidate && valueMatchesKind(field.descriptor.kind, candidate) ? candidate : field.value, included: message.excludedKeys ? !message.excludedKeys.includes(field.descriptor.key) : field.included }, message.fieldWaitAfterFillMs); }); const fieldsByKey = new Map(updatedFields.map((field) => [field.descriptor.key, field])); const reorderedFields = message.fieldOrder ? [...message.fieldOrder].map((key) => fieldsByKey.get(key)).filter((field): field is SavedFilling['fields'][number] => !!field) : []; const orderedKeys = new Set(message.fieldOrder ?? []); const updated = { ...old, name: message.name?.trim() || old.name, fields: message.fieldOrder ? [...reorderedFields, ...updatedFields.filter((field) => !orderedKeys.has(field.descriptor.key))] : updatedFields, waitAfterFillMs: message.waitAfterFillMs === undefined ? old.waitAfterFillMs : normalizeWaitAfterFillMs(message.waitAfterFillMs), updatedAt: Date.now() }; await setEntryEnvelope(updated.id, await encryptRecord(key, updated)); return { ok: true, requestId: message.requestId, filling: updated };
  }
  if (message.type === 'DELETE_FILLING') { const ids = await getEntryIds(); await deleteEntryEnvelope(message.id); await setEntryIds(ids.filter((id) => id !== message.id)); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'DELETE_SITE_FILLINGS') { const entries = await allEntries(key); const remove = entries.filter((entry) => entry.form.origin === message.origin).map((entry) => entry.id); const ids = await getEntryIds(); for (const id of remove) await deleteEntryEnvelope(id); await setEntryIds(ids.filter((id) => !remove.includes(id))); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'CLEAR_VAULT') { const ids = await getEntryIds(); for (const id of ids) await deleteEntryEnvelope(id); await setEntryIds([]); await lockVault(); await removeLocal('vaultMeta'); return { ok: true, requestId: message.requestId }; }
  if (message.type === 'START_FILL') {
    await debugLog('START_FILL requested', { tabId, entryId: message.id, origin: message.form.origin, pathname: message.form.pathname });
    if (tabId === undefined) throw new Error('Replay requires a browser tab.');
    if (senderOrigin !== message.form.origin || !(await enabled(message.form.origin))) throw new Error('This site is not authorized.');
    const candidates = await allEntries(key);
    const current = message.fields ? { form: message.form, fields: message.fields, capturedAt: 0, revision: 0, completeness: 'complete' as const } : undefined;
    if (current) {
      for (const candidate of candidates) await debugLog('fill.match.candidate', { tabId, requestedEntryId: message.id, entryId: candidate.id, entryName: candidate.name, ...explainSnapshotMatch(candidate, current) });
    }
    const entry = (current ? matchesForSnapshot(candidates, current) : matchesForForm(candidates, message.form)).find((item) => item.id === message.id);
    if (!entry) throw new Error('Saved filling does not match this form.');
    const fill = await withTabQueue(tabId, () => cdpReplay(tabId, entry, message.form));
    await setEntryEnvelope(entry.id, await encryptRecord(key, { ...entry, lastUsedAt: Date.now() }));
    return { ok: true, requestId: message.requestId, fill };
  }
  throw new Error('Unsupported operation.');
}

async function lockVault(): Promise<void> { dataKey = undefined; await chrome.storage.session.clear(); await broadcast({ type: 'VAULT_STATE', unlocked: false }); }
function installListeners(): void {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => { if (!isMessage(raw)) { sendResponse({ ok: false, error: 'Invalid message.' }); return false; } void handle(raw, sender).then((response) => sendResponse(response)).catch((error) => sendResponse({ ok: false, requestId: raw.requestId, error: error instanceof Error ? error.message : 'Operation failed.' })); return true; });
  chrome.runtime.onStartup.addListener(() => { void reconcile(); }); chrome.runtime.onInstalled.addListener(() => { void reconcile(); });
  chrome.permissions.onAdded.addListener((permissions) => { void finishPendingEnable(permissions.origins ?? []); });
  chrome.permissions.onRemoved.addListener((permissions) => { for (const removedPattern of permissions.origins ?? []) { void (async () => { const config = await getConfig(); const removed = config.enabledOrigins.filter((item) => permissionPattern(item) === removedPattern); config.enabledOrigins = config.enabledOrigins.filter((item) => !removed.includes(item)); await setConfig(config); for (const origin of removed) await unregisterOrigin(origin); })(); } });
  chrome.tabs.onRemoved.addListener((tabId) => { cancelTabs.add(tabId); }); chrome.debugger.onDetach.addListener(({ tabId }) => { if (tabId !== undefined) cancelTabs.add(tabId); });
  chrome.alarms.create('form-filler-maintenance', { periodInMinutes: 5 }); chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'form-filler-maintenance') void (async () => { if (dataKey && !(await unlocked())) return; if (dataKey) await pendingDrafts(dataKey); })(); });
}
installListeners();
