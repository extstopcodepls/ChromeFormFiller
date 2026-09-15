import type { CapturedField, FillResult, FormIdentity, FormSnapshot, MatchSummary, PendingDraft, SavedFilling, SiteStatus } from './types';

export type Message =
  | { type: 'GET_SITE_STATUS'; requestId: string; tabUrl?: string }
  | { type: 'SET_DEBUG'; requestId: string; enabled: boolean }
  | { type: 'ENABLE_SITE_INTENT'; requestId: string; tabUrl?: string }
  | { type: 'CANCEL_ENABLE_SITE_INTENT'; requestId: string }
  | { type: 'ENABLE_SITE'; requestId: string; tabUrl?: string; permissionGranted?: boolean }
  | { type: 'DISABLE_SITE'; requestId: string; tabUrl?: string }
  | { type: 'UNLOCK_VAULT'; requestId: string; passphrase: string }
  | { type: 'LOCK_VAULT'; requestId: string }
  | { type: 'LIST_MATCHES'; requestId: string; form: FormIdentity; fields?: CapturedField[] }
  | { type: 'CAPTURE_FORM'; requestId: string; form: FormSnapshot; saveDraft?: boolean }
  | { type: 'SUBMISSION_OBSERVED'; requestId: string; form: FormSnapshot }
  | { type: 'SAVE_FILLING'; requestId: string; draftId?: string; filling?: SavedFilling; name?: string; excludedKeys?: string[] }
  | { type: 'UPDATE_FILLING'; requestId: string; id: string; name?: string; excludedKeys?: string[] }
  | { type: 'DELETE_FILLING'; requestId: string; id: string }
  | { type: 'DELETE_SITE_FILLINGS'; requestId: string; origin: string }
  | { type: 'CLEAR_VAULT'; requestId: string }
  | { type: 'LIST_LIBRARY'; requestId: string }
  | { type: 'GET_DRAFT'; requestId: string; id: string }
  | { type: 'DISMISS_DRAFT'; requestId: string; id: string }
  | { type: 'IGNORE_FORM'; requestId: string; form: FormIdentity }
  | { type: 'START_FILL'; requestId: string; id: string; form: FormIdentity; fields?: CapturedField[] }
  | { type: 'CANCEL_FILL'; requestId: string; tabId?: number }
  | { type: 'OPEN_LIBRARY'; requestId: string; draftId?: string };

export type Response = {
  ok: true;
  requestId?: string;
  status?: SiteStatus;
  matches?: MatchSummary[];
  filling?: SavedFilling;
  fillings?: SavedFilling[];
  draft?: PendingDraft;
  drafts?: PendingDraft[];
  draftId?: string;
  fill?: FillResult;
  message?: string;
} | { ok: false; requestId?: string; error: string };

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === 'string' && typeof candidate.requestId === 'string';
}

export function sendMessage<T extends Response>(message: Message): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) resolve({ ok: false, requestId: message.requestId, error: chrome.runtime.lastError.message ?? 'Extension unavailable' } as T);
      else resolve(response ?? ({ ok: false, requestId: message.requestId, error: 'Empty response' } as T));
    });
  });
}

export function responseError(error: unknown): Response {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
