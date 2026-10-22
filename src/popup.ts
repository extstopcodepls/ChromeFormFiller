import './ui.css';
import { newRequestId, sendMessage } from './messages';
import type { SiteStatus } from './types';

const app = document.querySelector('#app')!;
let activeTab: chrome.tabs.Tab | undefined;
let status: SiteStatus | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function showError(error: string): void { const node = document.querySelector<HTMLElement>('#error'); if (node) { node.hidden = false; node.textContent = error; } }
function render(): void {
  app.replaceChildren(); const panel = el('section', 'panel'); const host = status?.origin || 'This page'; panel.append(el('h1', 'title', 'Form Filler'), el('div', 'muted', host));
  const state = el('div', 'status', status?.unlocked ? 'Vault unlocked — form values can be captured for this enabled site.' : 'Vault locked — saved values are not available.'); panel.append(state);
  const stack = el('div', 'stack');
  const debugLabel = el('label', 'check-row');
  const debug = document.createElement('input'); debug.type = 'checkbox'; debug.checked = !!status?.debug;
  debugLabel.append(debug, el('span', undefined, 'Enable debug logging'));
  debugLabel.title = 'Logs matching and filling decisions to Chrome DevTools without field values or file paths.';
  debug.addEventListener('change', () => void sendMessage<any>({ type: 'SET_DEBUG', requestId: newRequestId(), enabled: debug.checked }).then((response) => {
    if (!response.ok) { debug.checked = !debug.checked; showError(response.error); return; }
    status = response.status ?? status; render();
  }));
  stack.append(debugLabel);
  if (status?.enabled) { const disable = el('button', 'button', 'Disable on this site'); disable.addEventListener('click', () => void run('DISABLE_SITE')); stack.append(disable); }
  else { const enable = el('button', 'button primary', 'Enable on this site'); enable.addEventListener('click', () => void enableSite()); stack.append(enable); }
  if (status?.unlocked) { const lock = el('button', 'button', 'Lock vault'); lock.addEventListener('click', () => void run('LOCK_VAULT')); stack.append(lock); }
  else { const unlock = el('button', 'button primary', 'Unlock vault'); unlock.addEventListener('click', () => unlockPrompt()); stack.append(unlock); }
  const open = el('button', 'link', 'Open saved fillings'); open.addEventListener('click', () => void sendMessage<any>({ type: 'OPEN_LIBRARY', requestId: newRequestId() })); stack.append(open);
  if ((status?.pendingCount ?? 0) > 0) { const pending = el('div', 'status', `${status!.pendingCount} submission candidate${status!.pendingCount === 1 ? '' : 's'} waiting for review.`); const review = el('button', 'button primary', 'Review and save'); review.addEventListener('click', () => void sendMessage<any>({ type: 'OPEN_LIBRARY', requestId: newRequestId() })); pending.append(el('br'), review); stack.append(pending); }
  const error = el('div', 'status small', ''); error.id = 'error'; error.hidden = true; stack.append(error); panel.append(stack); app.append(panel);
}
function renderLoading(): void {
  const panel = el('section', 'panel');
  panel.append(el('h1', 'title', 'Form Filler'), el('div', 'status', 'Connecting to the extension…'));
  app.replaceChildren(panel);
}
function renderLoadError(error: unknown): void {
  const panel = el('section', 'panel');
  const message = el('div', 'status small', error instanceof Error ? error.message : 'Unable to connect to the extension.');
  message.id = 'error'; message.setAttribute('role', 'alert');
  const retry = el('button', 'button primary', 'Try again');
  retry.addEventListener('click', () => void load());
  const library = el('button', 'link', 'Open saved fillings');
  library.addEventListener('click', () => { void chrome.runtime.openOptionsPage().catch(showError); });
  const stack = el('div', 'stack'); stack.append(retry, library);
  panel.append(el('h1', 'title', 'Form Filler'), message, stack);
  app.replaceChildren(panel);
}
async function load(): Promise<void> {
  renderLoading();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs[0];
        return sendMessage<any>({ type: 'GET_SITE_STATUS', requestId: newRequestId(), tabUrl: activeTab?.url });
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The extension did not respond. Try again to reconnect.')), 8000);
      })
    ]);
    if (!response.ok) throw new Error(response.error);
    status = response.status;
    render();
  } catch (error) {
    renderLoadError(error);
  } finally {
    clearTimeout(timeout);
  }
}
async function enableSite(): Promise<void> { try { const url = new URL(activeTab?.url ?? ''); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only ordinary HTTP and HTTPS pages can be enabled.'); const intent = sendMessage<any>({ type: 'ENABLE_SITE_INTENT', requestId: newRequestId(), tabUrl: activeTab?.url }); const permissionRequest = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }); await intent; const granted = await permissionRequest; if (!granted) { await sendMessage<any>({ type: 'CANCEL_ENABLE_SITE_INTENT', requestId: newRequestId() }); throw new Error('Site permission was not granted.'); } await run('ENABLE_SITE', true); } catch (error) { showError(error instanceof Error ? error.message : 'Unable to enable this site.'); } }
async function run(type: 'DISABLE_SITE' | 'LOCK_VAULT' | 'ENABLE_SITE', permissionGranted = false): Promise<void> { const response = await sendMessage<any>({ type, requestId: newRequestId(), tabUrl: activeTab?.url, permissionGranted }); if (response.ok) { status = response.status ?? status; if (type === 'LOCK_VAULT') status = { ...status!, unlocked: false, pendingCount: 0 }; render(); } else showError(response.error); }
function unlockPrompt(): void { const passphrase = window.prompt('Enter your vault passphrase. On first unlock, this creates the vault. Passphrase recovery is not available.'); if (passphrase === null) return; void sendMessage<any>({ type: 'UNLOCK_VAULT', requestId: newRequestId(), passphrase }).then((response) => { if (!response.ok) showError(response.error); else void load(); }); }
void load();
