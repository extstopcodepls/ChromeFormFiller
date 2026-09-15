import './ui.css';
import { newRequestId, sendMessage } from './messages';
import type { CapturedField, PendingDraft, SavedFilling } from './types';

const app = document.querySelector('#app')!; let entries: SavedFilling[] = []; let draft: PendingDraft | undefined; let unlocked = false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function message(type: string, extra: Record<string, unknown> = {}): Promise<any> { return sendMessage<any>({ type, requestId: newRequestId(), ...extra } as any); }
function show(text: string, kind = 'status'): HTMLElement { const node = el('div', kind, text); return node; }
function renderShell(): void { app.replaceChildren(); const page = el('main', 'page'); page.append(el('h1', 'title', 'Saved fillings'), el('p', 'muted', 'Values and reusable file paths are encrypted locally. The vault has no passphrase recovery.'), renderUnlock(), renderDraft(), renderLibrary()); app.append(page); }
function renderUnlock(): HTMLElement { const card = el('section', 'card'); if (unlocked) { card.append(el('div', 'muted', 'Vault is unlocked for this extension session.')); const lock = el('button', 'button', 'Lock vault'); lock.addEventListener('click', () => void message('LOCK_VAULT').then(() => { unlocked = false; entries = []; draft = undefined; renderShell(); })); card.append(el('div', 'row'), lock); return card; } const form = el('form', 'stack'); const label = el('label', 'field'); label.append(el('span', undefined, 'Passphrase (8+ characters)')); const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'current-password'; label.append(input); const submit = el('button', 'button primary', 'Unlock / create vault'); form.append(label, submit); form.addEventListener('submit', (event) => { event.preventDefault(); void message('UNLOCK_VAULT', { passphrase: input.value }).then((response) => { if (!response.ok) card.append(show(response.error)); else { unlocked = true; void loadData(); } }); }); card.append(form); return card; }
function renderDraft(): HTMLElement { const card = el('section', `card draft${draft ? '' : ''}`); if (!draft) { card.hidden = true; return card; } card.append(el('h2', undefined, draft.submissionObserved ? 'Save this filling?' : 'Review captured filling'), el('p', 'muted', draft.basedOnEarlierSnapshot ? `This snapshot was captured at ${new Date(draft.capturedAt).toLocaleString()}; recent changes may be missing.` : 'This is a submission attempt, not proof that the server accepted it.'));
  const name = document.createElement('input'); name.value = `${draft.form.origin.replace(/^https?:\/\//, '')}${draft.form.pathname === '/' ? '' : draft.form.pathname}`; name.ariaLabel = 'Filling name'; const nameLabel = el('label', 'field'); nameLabel.append(el('span', undefined, 'Name')); nameLabel.append(name); card.append(nameLabel);
  const fields = fieldChecklist(draft.fields); card.append(fields.node); const row = el('div', 'row'); const save = el('button', 'button primary', 'Save new'); save.addEventListener('click', () => void saveDraft(name.value, fields.excluded())); const update = el('button', 'button', 'Update an existing match'); update.addEventListener('click', () => { const matching = entries.find((entry) => entry.form.origin === draft!.form.origin && entry.form.pathname === draft!.form.pathname && entry.form.fingerprint === draft!.form.fingerprint); if (!matching) { card.append(show('No existing matching filling is available.')); return; } void message('UPDATE_FILLING', { id: matching.id, name: name.value, excludedKeys: fields.excluded() }).then((response) => { if (response.ok) { draft = undefined; void loadData(); } else card.append(show(response.error)); }); }); const dismiss = el('button', 'button danger', 'Dismiss'); dismiss.addEventListener('click', () => void message('DISMISS_DRAFT', { id: draft!.id }).then(() => { draft = undefined; renderShell(); })); const never = el('button', 'button danger', 'Never offer for this form'); never.addEventListener('click', () => void message('IGNORE_FORM', { form: draft!.form }).then((response) => { if (response.ok) { draft = undefined; void loadData(); } else card.append(show(response.error)); })); row.append(save, update, dismiss, never); card.append(row); return card; }
function fieldChecklist(fields: CapturedField[]): { node: HTMLElement; excluded: () => string[] } {
  const node = el('div', 'fields');
  const checks: { key: string; check: HTMLInputElement }[] = [];
  const controls = el('div', 'row');
  const setAll = (checked: boolean): void => checks.forEach(({ check }) => { if (!check.disabled) check.checked = checked; });
  const checkAll = el('button', 'button', 'Check all');
  checkAll.type = 'button';
  checkAll.addEventListener('click', () => setAll(true));
  const uncheckAll = el('button', 'button', 'Uncheck all');
  uncheckAll.type = 'button';
  uncheckAll.addEventListener('click', () => setAll(false));
  controls.append(checkAll, uncheckAll);
  node.append(controls);
  fields.forEach((field) => {
    const label = el('label', 'check');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = field.included;
    check.disabled = !!field.unavailableReason;
    const text = el('span');
    text.append(document.createTextNode(`${field.descriptor.label || field.descriptor.name || field.descriptor.kind}: `));
    const value = field.value.tag === 'file' ? (field.value.files.map((file) => file.name).join(', ') || 'no file') : field.value.tag === 'options' ? field.value.values.join(', ') : field.value.tag === 'boolean' ? String(field.value.value) : field.value.tag === 'radio' ? (field.value.value ?? 'none selected') : field.value.value;
    text.append(el('code', undefined, value || '(empty)'));
    if (field.unavailableReason) text.append(el('small', 'muted', ` — ${field.unavailableReason}`));
    label.append(check, text);
    node.append(label);
    checks.push({ key: field.descriptor.key, check });
  });
  return { node, excluded: () => checks.filter((item) => !item.check.checked).map((item) => item.key) };
}
async function saveDraft(name: string, excludedKeys: string[]): Promise<void> { if (!draft) return; const response = await message('SAVE_FILLING', { draftId: draft.id, name, excludedKeys }); if (!response.ok) { app.querySelector('.draft')?.append(show(response.error)); return; } draft = undefined; await loadData(); }
function renderLibrary(): HTMLElement { const wrap = el('section'); const header = el('div', 'row'); header.append(el('h2', undefined, 'Your fillings')); const search = document.createElement('input'); search.placeholder = 'Search by name, site, or path'; search.addEventListener('input', () => renderEntries(wrap, search.value)); header.append(search); const clear = el('button', 'button danger', 'Clear vault'); clear.addEventListener('click', () => { if (confirm('Delete every saved filling and lock the vault?')) void message('CLEAR_VAULT').then(() => { unlocked = false; entries = []; draft = undefined; renderShell(); }); }); header.append(clear); wrap.append(header); renderEntries(wrap, ''); return wrap; }
function renderEntries(wrap: HTMLElement, query: string): void { wrap.querySelectorAll('.entry-card').forEach((node) => node.remove()); const normalized = query.toLowerCase(); const grouped = entries.filter((entry) => `${entry.name} ${entry.form.origin} ${entry.form.pathname}`.toLowerCase().includes(normalized)); if (!grouped.length) { wrap.append(el('div', 'card entry-card muted', entries.length ? 'No fillings match your search.' : 'No saved fillings yet.')); return; } for (const entry of grouped) { const card = el('article', 'card entry-card'); const layout = el('div', 'entry'); const copy = el('div'); copy.append(el('h3', undefined, entry.name), el('small', undefined, `${entry.form.origin}${entry.form.pathname} · ${entry.fields.filter((field) => field.included).length} included fields · updated ${new Date(entry.updatedAt).toLocaleDateString()}`)); const actions = el('div', 'row'); const rename = el('button', 'button', 'Rename'); rename.addEventListener('click', () => { const name = prompt('New filling name', entry.name); if (name?.trim()) void message('UPDATE_FILLING', { id: entry.id, name: name.trim() }).then((response) => { if (response.ok) void loadData(); }); }); const remove = el('button', 'button danger', 'Delete'); remove.addEventListener('click', () => { if (confirm(`Delete “${entry.name}”?`)) void message('DELETE_FILLING', { id: entry.id }).then((response) => { if (response.ok) void loadData(); }); }); actions.append(rename, remove); layout.append(copy, actions); card.append(layout); wrap.append(card); } }
async function loadData(): Promise<void> { const response = await message('LIST_LIBRARY'); if (!response.ok) { unlocked = false; renderShell(); return; } entries = response.fillings ?? []; const params = new URLSearchParams(location.search); const draftId = params.get('draft'); if (draftId) { const draftResponse = await message('GET_DRAFT', { id: draftId }); draft = draftResponse.ok ? draftResponse.draft : undefined; } else draft = response.drafts?.[0]; renderShell(); }
void (async () => { const response = await message('LIST_LIBRARY'); if (response.ok) { unlocked = true; entries = response.fillings ?? []; await loadData(); } else renderShell(); })();
