import './ui.css';
import { newRequestId, sendMessage } from './messages';
import { MAX_WAIT_AFTER_FILL_MS } from './delay';
import type { CapturedField, FieldValue, PendingDraft, SavedFilling } from './types';
import { createUnlockForm } from './unlock-form';

const app = document.querySelector('#app')!; let entries: SavedFilling[] = []; let draft: PendingDraft | undefined; let unlocked = false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function message(type: string, extra: Record<string, unknown> = {}): Promise<any> { return sendMessage<any>({ type, requestId: newRequestId(), ...extra } as any); }
function show(text: string, kind = 'status'): HTMLElement { const node = el('div', kind, text); return node; }
function waitInput(value: number | undefined = 0, perField = false): { node: HTMLElement; read: () => number | null } {
  const label = el('label', 'editor-field'); label.append(el('span', undefined, perField ? 'Wait after this field (milliseconds)' : 'Default wait after each field (milliseconds)'));
  const hasValue = value !== undefined && Number.isInteger(value) && value >= 0 && value <= MAX_WAIT_AFTER_FILL_MS;
  const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = String(MAX_WAIT_AFTER_FILL_MS); input.step = '1'; input.value = hasValue ? String(value) : ''; input.placeholder = perField ? 'Use default' : '0'; input.ariaLabel = perField ? 'Wait after this field in milliseconds, blank uses default' : 'Default wait after each field in milliseconds';
  label.append(input, el('small', undefined, perField ? 'Leave blank to use the filling default.' : 'Applied after each included field is set and verified.')); return { node: label, read: () => { if (perField && input.value.trim() === '') return null; const parsed = Number(input.value); return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_WAIT_AFTER_FILL_MS ? parsed : 0; } };
}
function renderShell(): void { app.replaceChildren(); const page = el('main', 'page'); page.append(el('h1', 'title', 'Saved fillings'), el('p', 'muted', 'Values and reusable file paths are encrypted locally. The vault has no passphrase recovery.'), renderUnlock(), renderDraft(), renderLibrary()); app.append(page); }
function renderUnlock(): HTMLElement {
  const card = el('section', 'card');
  if (unlocked) {
    card.append(el('div', 'muted', 'Vault is unlocked for this extension session.'));
    const lock = el('button', 'button', 'Lock vault');
    lock.addEventListener('click', () => void message('LOCK_VAULT').then(() => { unlocked = false; entries = []; draft = undefined; renderShell(); }));
    card.append(el('div', 'row'), lock);
  } else card.append(createUnlockForm(() => { unlocked = true; void loadData(); }));
  return card;
}
function renderDraft(): HTMLElement { const card = el('section', `card draft${draft ? '' : ''}`); if (!draft) { card.hidden = true; return card; } card.append(el('h2', undefined, draft.submissionObserved ? 'Save this filling?' : 'Review captured filling'), el('p', 'muted', draft.basedOnEarlierSnapshot ? `This snapshot was captured at ${new Date(draft.capturedAt).toLocaleString()}; recent changes may be missing.` : 'This is a submission attempt, not proof that the server accepted it.'));
  const name = document.createElement('input'); name.value = `${draft.form.origin.replace(/^https?:\/\//, '')}${draft.form.pathname === '/' ? '' : draft.form.pathname}`; name.ariaLabel = 'Filling name'; const nameLabel = el('label', 'field'); nameLabel.append(el('span', undefined, 'Name')); nameLabel.append(name); const delay = waitInput(); card.append(nameLabel, delay.node);
  const fields = fieldChecklist(draft.fields); card.append(fields.node); const row = el('div', 'row'); const save = el('button', 'button primary', 'Save new'); save.addEventListener('click', () => void saveDraft(name.value, fields.excluded(), delay.read() ?? 0, fields.waits())); const update = el('button', 'button', 'Update an existing match'); update.addEventListener('click', () => { const matching = entries.find((entry) => entry.form.origin === draft!.form.origin && entry.form.pathname === draft!.form.pathname && entry.form.fingerprint === draft!.form.fingerprint); if (!matching) { card.append(show('No existing matching filling is available.')); return; } void message('UPDATE_FILLING', { id: matching.id, name: name.value, excludedKeys: fields.excluded(), waitAfterFillMs: delay.read() ?? 0, fieldWaitAfterFillMs: fields.waits() }).then((response) => { if (response.ok) { draft = undefined; void loadData(); } else card.append(show(response.error)); }); }); const dismiss = el('button', 'button danger', 'Dismiss'); dismiss.addEventListener('click', () => void message('DISMISS_DRAFT', { id: draft!.id }).then(() => { draft = undefined; renderShell(); })); const never = el('button', 'button danger', 'Never offer for this form'); never.addEventListener('click', () => void message('IGNORE_FORM', { form: draft!.form }).then((response) => { if (response.ok) { draft = undefined; void loadData(); } else card.append(show(response.error)); })); row.append(save, update, dismiss, never); card.append(row); return card; }
function fieldChecklist(fields: CapturedField[]): { node: HTMLElement; excluded: () => string[]; waits: () => Record<string, number | null> } {
  const node = el('div', 'fields');
  const checks: { key: string; check: HTMLInputElement }[] = [];
  const waits = new Map<string, () => number | null>();
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
    const row = el('div', 'field-check-row'); const wait = waitInput(field.waitAfterFillMs, true); row.append(label, wait.node); node.append(row); waits.set(field.descriptor.key, wait.read);
    checks.push({ key: field.descriptor.key, check });
  });
  return { node, excluded: () => checks.filter((item) => !item.check.checked).map((item) => item.key), waits: () => Object.fromEntries([...waits.entries()].map(([key, read]) => [key, read()])) };
}
async function saveDraft(name: string, excludedKeys: string[], waitAfterFillMs: number, fieldWaitAfterFillMs: Record<string, number | null>): Promise<void> { if (!draft) return; const response = await message('SAVE_FILLING', { draftId: draft.id, name, excludedKeys, waitAfterFillMs, fieldWaitAfterFillMs }); if (!response.ok) { app.querySelector('.draft')?.append(show(response.error)); return; } draft = undefined; await loadData(); }
function fieldLabel(field: CapturedField): string { return field.descriptor.label || field.descriptor.name || field.descriptor.kind; }
function editorTextValue(field: CapturedField): string { if (field.value.tag === 'text') return field.value.value; if (field.value.tag === 'boolean') return String(field.value.value); if (field.value.tag === 'radio') return field.value.value ?? ''; if (field.value.tag === 'options') return field.value.values.join(', '); return field.value.files.map((file) => file.name).join(', '); }
function renderValueEditor(field: CapturedField, showLabel = true): { node: HTMLElement; read: () => FieldValue } {
  const label = el('label', 'editor-field'); if (showLabel) label.append(el('span', undefined, fieldLabel(field)));
  if (field.value.tag === 'file') { label.append(el('small', undefined, field.value.files.length ? `Saved files: ${field.value.files.map((file) => file.name).join(', ')}` : 'No file selected. File selections must be captured again from the form.')); return { node: label, read: () => field.value }; }
  if (field.value.tag === 'boolean') { const input = document.createElement('input'); input.type = 'checkbox'; input.checked = field.value.value; const toggle = el('span', 'editor-toggle'); toggle.append(input, document.createTextNode('Enabled')); label.replaceChildren(toggle); return { node: label, read: () => ({ tag: 'boolean', value: input.checked }) }; }
  const input = field.descriptor.kind === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (input instanceof HTMLInputElement) { input.type = ['text', 'search', 'email', 'url', 'tel', 'number', 'range', 'date', 'time', 'month', 'week', 'datetime-local', 'color'].includes(field.descriptor.kind) ? field.descriptor.kind : 'text'; }
  input.value = editorTextValue(field); input.ariaLabel = fieldLabel(field); label.append(input);
  if (field.value.tag === 'options') label.append(el('small', undefined, 'For multiple selections, separate option values with commas.'));
  if (field.value.tag === 'radio') label.append(el('small', undefined, 'Enter the saved option value, or leave blank for no selection.'));
  return { node: label, read: () => field.value.tag === 'options' ? { tag: 'options', values: input.value.split(',').map((value) => value.trim()).filter(Boolean) } : field.value.tag === 'radio' ? { tag: 'radio', value: input.value || null } : { tag: 'text', value: input.value } };
}
function renderEntryEditor(entry: SavedFilling, onCancel: () => void): HTMLElement {
  const editor = el('div', 'editor'); const name = document.createElement('input'); name.value = entry.name; name.ariaLabel = 'Filling name'; const nameLabel = el('label', 'editor-field'); nameLabel.append(el('span', undefined, 'Name'), name); const delay = waitInput(entry.waitAfterFillMs); editor.append(nameLabel, delay.node);
  editor.append(el('p', 'muted small', 'Arrange fields in the order they should be filled.'));
  const fields = el('div', 'editor-fields'); const values = new Map<string, () => FieldValue>(); const included = new Map<string, HTMLInputElement>();
  const fieldOrder = [...entry.fields]; const rows = new Map<string, HTMLElement>(); const moveButtons = new Map<string, { up: HTMLButtonElement; down: HTMLButtonElement }>();
  const updateMoveButtons = (): void => fieldOrder.forEach((field, index) => { const buttons = moveButtons.get(field.descriptor.key)!; buttons.up.disabled = index === 0; buttons.down.disabled = index === fieldOrder.length - 1; });
  const moveField = (key: string, direction: -1 | 1): void => { const index = fieldOrder.findIndex((field) => field.descriptor.key === key); const nextIndex = index + direction; if (index < 0 || nextIndex < 0 || nextIndex >= fieldOrder.length) return; const [field] = fieldOrder.splice(index, 1); fieldOrder.splice(nextIndex, 0, field); const row = rows.get(key)!; const nextRow = fields.children[nextIndex]; if (direction < 0) fields.insertBefore(row, nextRow); else fields.insertBefore(row, nextRow?.nextSibling ?? null); updateMoveButtons(); };
  const fieldWaits = new Map<string, () => number | null>();
  for (const field of fieldOrder) { const row = el('div', 'editor-field-row'); const header = el('div', 'editor-field-header'); header.append(el('strong', 'editor-field-name', fieldLabel(field))); const toggle = el('label', 'editor-toggle'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = field.included; toggle.append(check, document.createTextNode('Use in filling')); const valueEditor = renderValueEditor(field, false); const fieldDelay = waitInput(field.waitAfterFillMs, true); const controls = el('div', 'editor-reorder'); const up = el('button', 'button reorder-button', '↑'); up.type = 'button'; up.ariaLabel = `Move ${fieldLabel(field)} up`; up.title = up.ariaLabel; const down = el('button', 'button reorder-button', '↓'); down.type = 'button'; down.ariaLabel = `Move ${fieldLabel(field)} down`; down.title = down.ariaLabel; up.addEventListener('click', () => moveField(field.descriptor.key, -1)); down.addEventListener('click', () => moveField(field.descriptor.key, 1)); controls.append(up, down); header.append(toggle, controls); row.append(header, valueEditor.node, fieldDelay.node); fields.append(row); rows.set(field.descriptor.key, row); moveButtons.set(field.descriptor.key, { up, down }); values.set(field.descriptor.key, valueEditor.read); included.set(field.descriptor.key, check); fieldWaits.set(field.descriptor.key, fieldDelay.read); }
  updateMoveButtons();
  editor.append(fields); const actions = el('div', 'row'); const save = el('button', 'button primary', 'Save changes'); save.addEventListener('click', () => { const fieldValues: Record<string, FieldValue> = {}; const fieldWaitAfterFillMs: Record<string, number | null> = {}; const excludedKeys: string[] = []; for (const field of fieldOrder) { fieldValues[field.descriptor.key] = values.get(field.descriptor.key)!(); fieldWaitAfterFillMs[field.descriptor.key] = fieldWaits.get(field.descriptor.key)!(); if (!included.get(field.descriptor.key)!.checked) excludedKeys.push(field.descriptor.key); } save.disabled = true; void message('UPDATE_FILLING', { id: entry.id, name: name.value, fieldValues, excludedKeys, fieldOrder: fieldOrder.map((field) => field.descriptor.key), waitAfterFillMs: delay.read() ?? 0, fieldWaitAfterFillMs }).then((response) => { if (response.ok) void loadData(); else { save.disabled = false; editor.append(show(response.error)); } }); }); const cancel = el('button', 'button', 'Cancel'); cancel.addEventListener('click', onCancel); actions.append(save, cancel); editor.append(actions); return editor;
}
function renderLibrary(): HTMLElement { const wrap = el('section'); let editingId: string | undefined; const header = el('div', 'row'); header.append(el('h2', undefined, 'Your fillings')); const search = document.createElement('input'); search.placeholder = 'Search by name, site, or path'; const render = (): void => renderEntries(wrap, search.value, editingId, (id) => { editingId = id; render(); }); search.addEventListener('input', () => { editingId = undefined; render(); }); header.append(search); const clear = el('button', 'button danger', 'Clear vault'); clear.addEventListener('click', () => { if (confirm('Delete every saved filling and lock the vault?')) void message('CLEAR_VAULT').then(() => { unlocked = false; entries = []; draft = undefined; renderShell(); }); }); header.append(clear); wrap.append(header); render(); return wrap; }
function renderEntries(wrap: HTMLElement, query: string, editingId?: string, setEditing?: (id?: string) => void): void { wrap.querySelectorAll('.entry-card').forEach((node) => node.remove()); const normalized = query.toLowerCase(); const grouped = entries.filter((entry) => `${entry.name} ${entry.form.origin} ${entry.form.pathname}`.toLowerCase().includes(normalized)); if (!grouped.length) { wrap.append(el('div', 'card entry-card muted', entries.length ? 'No fillings match your search.' : 'No saved fillings yet.')); return; } for (const entry of grouped) { const card = el('article', 'card entry-card'); const layout = el('div', 'entry'); const copy = el('div'); copy.append(el('h3', undefined, entry.name), el('small', undefined, `${entry.form.origin}${entry.form.pathname} · ${entry.fields.filter((field) => field.included).length} included fields · updated ${new Date(entry.updatedAt).toLocaleDateString()}`)); const actions = el('div', 'row'); const edit = el('button', 'button', editingId === entry.id ? 'Editing…' : 'Edit values'); edit.disabled = editingId === entry.id; edit.addEventListener('click', () => setEditing?.(entry.id)); const rename = el('button', 'button', 'Rename'); rename.addEventListener('click', () => { const name = prompt('New filling name', entry.name); if (name?.trim()) void message('UPDATE_FILLING', { id: entry.id, name: name.trim() }).then((response) => { if (response.ok) void loadData(); }); }); const remove = el('button', 'button danger', 'Delete'); remove.addEventListener('click', () => { if (confirm(`Delete “${entry.name}”?`)) void message('DELETE_FILLING', { id: entry.id }).then((response) => { if (response.ok) void loadData(); }); }); actions.append(edit, rename, remove); layout.append(copy, actions); card.append(layout); if (editingId === entry.id) card.append(renderEntryEditor(entry, () => setEditing?.(undefined))); wrap.append(card); } }
async function loadData(): Promise<void> { const response = await message('LIST_LIBRARY'); if (!response.ok) { unlocked = false; renderShell(); return; } entries = response.fillings ?? []; const params = new URLSearchParams(location.search); const draftId = params.get('draft'); if (draftId) { const draftResponse = await message('GET_DRAFT', { id: draftId }); draft = draftResponse.ok ? draftResponse.draft : undefined; } else draft = response.drafts?.[0]; renderShell(); }
void (async () => { const response = await message('LIST_LIBRARY'); if (response.ok) { unlocked = true; entries = response.fillings ?? []; await loadData(); } else renderShell(); })();
