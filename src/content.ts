import type { CapturedField, ControlKind, FieldDescriptor, FieldMatchKey, FieldValue, FillResult, FormIdentity, FormSnapshot, MatchSummary } from './types';
import { createSubmissionGate } from './submission';

declare global { interface Window { __formFillerLoaded?: boolean; } }

// Content scripts can be injected more than once while a dynamic registration
// is being reconciled. Keep all runtime bindings function-scoped so a duplicate
// evaluation cannot collide with top-level lexical declarations in the page's
// extension world.
(() => {
if (!window.__formFillerLoaded) {
  window.__formFillerLoaded = true;
  void boot();
}

const sensitiveWords = /password|passwd|passcode|secret|token|otp|one.?time|verification|auth.?code|cvv|cvc|security.?code|card.?number|cc.?number|iban|ssn|social.?security/i;
const excludedTypes = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'password']);
let vaultUnlocked = false;
let debugEnabled = false;
let revision = 0;
let pendingPromptShown = false;
const controllers = new Map<HTMLFormElement, FormController>();
const delaySubmission = createSubmissionGate();

interface FormController { form: HTMLFormElement; host: HTMLDivElement; button: HTMLButtonElement; menu: HTMLDivElement; status: HTMLDivElement; matches: MatchSummary[]; dragged: boolean; draftId?: string; }

function newRequestId(): string { return crypto.randomUUID(); }
function sendMessage<T>(message: unknown): Promise<T> { return new Promise((resolve) => { chrome.runtime.sendMessage(message, (response: T) => { if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Extension unavailable' } as T); else resolve(response); }); }); }
function request<T extends { ok: boolean }>(message: unknown): Promise<T> { return sendMessage<T>(message); }
function labelFor(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (control.labels?.length) return Array.from(control.labels).map((label) => label.textContent?.trim() ?? '').join(' ').slice(0, 160);
  const labelledBy = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
  if (labelledBy) return labelledBy.slice(0, 160);
  const labelled = control.getAttribute('aria-label') || control.getAttribute('placeholder');
  return (labelled ?? '').trim().slice(0, 160);
}
function isSensitive(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  const autocomplete = control.getAttribute('autocomplete') ?? '';
  return sensitiveWords.test(`${control.name} ${control.id} ${autocomplete} ${labelFor(control)}`) || /^(cc-|one-time-code|new-password|current-password)/i.test(autocomplete);
}
function visible(control: HTMLElement): boolean { const style = getComputedStyle(control); const rect = control.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0; }
function controlsFor(form: HTMLFormElement): Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> {
  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')).filter((control) => control.form === form);
  return Array.from(new Set(controls));
}
function kindFor(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): ControlKind | undefined {
  if (control instanceof HTMLTextAreaElement) return 'textarea';
  if (control instanceof HTMLSelectElement) return control.multiple ? 'select-multiple' : 'select-one';
  const type = control.type.toLowerCase();
  if (excludedTypes.has(type)) return undefined;
  if (['text','search','email','url','tel','number','checkbox','radio','range','date','time','month','week','datetime-local','color','file'].includes(type)) return type as ControlKind;
  return 'text';
}
function eligible(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  const kind = kindFor(control); return !!kind && !control.disabled && !(control instanceof HTMLInputElement && control.readOnly) && !isSensitive(control);
}
function eligibilityReason(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (!kindFor(control)) return `excluded input type: ${control instanceof HTMLInputElement ? control.type.toLowerCase() : control.tagName.toLowerCase()}`;
  if (control.disabled) return 'disabled';
  if (control instanceof HTMLInputElement && control.readOnly) return 'read-only';
  if (isSensitive(control)) return 'sensitive field policy';
  return 'eligible';
}
function controlTrace(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, index: number): Record<string, unknown> {
  return { index, tag: control.tagName.toLowerCase(), type: control instanceof HTMLInputElement ? control.type.toLowerCase() : undefined, kind: kindFor(control), id: control.id || '(none)', name: control.name || '(none)', label: labelFor(control) || '(none)', eligible: eligible(control), reason: eligibilityReason(control) };
}
function formTrace(form: FormIdentity): Record<string, unknown> {
  return { origin: form.origin, pathname: form.pathname, id: form.formId || '(none)', name: form.formName || '(none)', index: form.formIndex, actionOrigin: form.actionOrigin, actionPath: form.actionPath, method: form.method, fingerprint: form.fingerprint };
}
function fieldTrace(field: CapturedField): Record<string, unknown> {
  const descriptor = field.descriptor;
  return { resultKey: descriptor.key, kind: descriptor.kind, matchKeys: descriptor.matchKeys ?? [], id: descriptor.id || '(none)', name: descriptor.name || '(none)', label: descriptor.label || '(none)', position: descriptor.index, included: field.included };
}
function optionSignature(control: HTMLSelectElement): string { return Array.from(control.options).map((option) => `${option.value}:${option.textContent?.trim() ?? ''}`).join('|').slice(0, 800); }
function stableFieldSignature(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const kind = kindFor(control)!;
  // IDs are frequently generated afresh on every render. Prefer the visible
  // label, then the submitted name, and finally the control kind/position.
  // The sequence itself remains part of the surrounding form signature.
  const stableName = labelFor(control).replace(/\s+/g, ' ').trim().toLowerCase() || control.name.trim().toLowerCase();
  return `${kind}:${stableName}:${control instanceof HTMLSelectElement ? optionSignature(control) : ''}`;
}
function formIdentity(form: HTMLFormElement, controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): FormIdentity {
  const current = new URL(location.href); const action = new URL(form.getAttribute('action') || location.href, location.href);
  // Non-editable controls are intentionally never saved, so they must not make an
  // otherwise identical form stop matching when a site rotates a hidden token or
  // changes its submit button markup.
  const signatures = controls.filter(eligible).map(stableFieldSignature).join('||');
  return { origin: current.origin, pathname: current.pathname, formId: form.id, formName: form.name, actionOrigin: action.origin, actionPath: action.pathname, method: (form.method || 'get').toUpperCase(), fingerprint: hash(signatures), formIndex: Array.from(document.forms).indexOf(form) };
}
function hash(value: string): string { let h = 2166136261; for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
function descriptor(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, kind: ControlKind, index: number, form: HTMLFormElement): FieldDescriptor {
  const label = labelFor(control);
  const matchKeys: FieldMatchKey[] = [
    ...(control.id ? [{ strategy: 'id' as const, value: control.id }] : []),
    ...(control.name ? [{ strategy: 'name' as const, value: control.name }] : []),
    ...(label ? [{ strategy: 'label' as const, value: label }] : []),
    { strategy: 'position', value: index },
  ];
  return { key: `field-${index}`, kind, name: control.name, id: control.id, label, index, matchKeys, optionSignature: control instanceof HTMLSelectElement ? optionSignature(control) : undefined, autocomplete: control.getAttribute('autocomplete') ?? undefined, formId: form.id || undefined, formName: form.name || undefined, constraints: control instanceof HTMLInputElement ? { min: control.min || undefined, max: control.max || undefined, step: control.step || undefined, pattern: control.pattern || undefined } : undefined };
}
function readValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, kind: ControlKind): FieldValue {
  if (kind === 'checkbox') return { tag: 'boolean', value: (control as HTMLInputElement).checked };
  if (kind === 'radio') return { tag: 'radio', value: (control as HTMLInputElement).checked ? control.value : null };
  if (kind === 'select-one' || kind === 'select-multiple') return { tag: 'options', values: Array.from((control as HTMLSelectElement).selectedOptions).map((option) => option.value) };
  if (kind === 'file') return { tag: 'file', files: Array.from((control as HTMLInputElement).files ?? []).map((file) => ({ name: file.name, size: file.size, lastModified: file.lastModified })) };
  return { tag: 'text', value: control.value };
}
function snapshot(form: HTMLFormElement): FormSnapshot {
  const all = controlsFor(form); const formId = formIdentity(form, all); const fields: CapturedField[] = [];
  all.forEach((control, index) => { if (!eligible(control)) return; const kind = kindFor(control)!; fields.push({ descriptor: descriptor(control, kind, index, form), value: readValue(control, kind), included: true, ...(kind === 'file' ? { unavailableReason: 'A reusable local path was not exposed by Chrome during capture.' } : {}) }); });
  return { form: formId, fields, capturedAt: Date.now(), revision, completeness: 'complete' };
}
function position(controller: FormController): void {
  controller.host.style.display = 'block';
  if (controller.dragged) return;
  const index = Array.from(controllers.values()).indexOf(controller);
  controller.host.style.left = 'auto';
  controller.host.style.right = '16px';
  controller.host.style.top = `${16 + Math.max(0, index) * 40}px`;
}
function enableDragging(controller: FormController): void {
  let pointerId: number | undefined; let startX = 0; let startY = 0; let originX = 0; let originY = 0; let moved = false;
  controller.button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId; startX = event.clientX; startY = event.clientY;
    const rect = controller.host.getBoundingClientRect(); originX = rect.left; originY = rect.top; moved = false;
    controller.button.setPointerCapture(pointerId);
  });
  controller.button.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX; const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true; controller.dragged = true;
    const left = Math.max(0, Math.min(innerWidth - controller.host.offsetWidth, originX + dx));
    const top = Math.max(0, Math.min(innerHeight - controller.host.offsetHeight, originY + dy));
    controller.host.style.left = `${Math.round(left)}px`; controller.host.style.top = `${Math.round(top)}px`; controller.host.style.right = 'auto';
  });
  const finish = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = undefined;
    if (moved) { controller.button.dataset.dragged = 'true'; window.setTimeout(() => delete controller.button.dataset.dragged, 0); }
  };
  controller.button.addEventListener('pointerup', finish);
  controller.button.addEventListener('pointercancel', finish);
}
function close(controller: FormController): void { controller.menu.hidden = true; controller.button.setAttribute('aria-expanded', 'false'); }
function debugLog(event: string, details: Record<string, unknown> = {}): void { if (!debugEnabled) return; const safe = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' && /(?:[A-Za-z]:\\|\\\\)/.test(value) ? 'The browser reported an error containing a local path.' : value])); console.info('[Form Filler]', event, safe); }
function setStatus(controller: FormController, text: string): void { controller.status.replaceChildren(document.createTextNode(text)); controller.status.hidden = !text; }
function showFillResult(controller: FormController, fillResult: FillResult): void {
  const failed = fillResult.fields.filter((field) => !['filled', 'unchanged'].includes(field.status));
  const summary = failed.length ? `Completed with ${failed.length} manual/failed field${failed.length === 1 ? '' : 's'}.` : 'Filling verified.';
  controller.status.replaceChildren(document.createTextNode(summary));
  if (failed.length) {
    const details = document.createElement('details'); const heading = document.createElement('summary'); heading.textContent = 'Field details'; details.append(heading);
    const list = document.createElement('ul');
    for (const field of failed) { const item = document.createElement('li'); item.textContent = `${field.fieldName}: ${field.status}${field.message ? ` — ${field.message}` : ''}`; list.append(item); }
    details.append(list); controller.status.append(details);
  }
  controller.status.hidden = false;
}
function formatDate(timestamp?: number): string { return timestamp ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'never used'; }
function currentSummary(field: CapturedField): string { const value = field.value; if (value.tag === 'file') return value.files.map((file) => file.name).join(', ') || '(empty file selection)'; if (value.tag === 'options') return value.values.join(', ') || '(empty selection)'; if (value.tag === 'boolean') return String(value.value); if (value.tag === 'radio') return value.value ?? '(none selected)'; return value.value || '(empty)'; }
function renderMenu(controller: FormController): void {
  controller.menu.replaceChildren();
  if (!vaultUnlocked) { const locked = document.createElement('div'); locked.className = 'notice'; locked.textContent = 'Unlock to save or fill.'; controller.menu.append(locked); return; }
  if (controller.matches.length) { const heading = document.createElement('div'); heading.className = 'menu-heading'; heading.textContent = 'Saved fillings'; controller.menu.append(heading); }
  for (const match of controller.matches) { const item = document.createElement('button'); item.className = 'menu-item'; item.type = 'button'; item.innerHTML = `<span>${escapeHtml(match.name)}</span><small>${formatDate(match.lastUsedAt)} · ${match.fieldCount} fields</small>`; item.addEventListener('click', () => previewFill(controller, match)); controller.menu.append(item); }
  const save = document.createElement('button'); save.className = 'menu-item action'; save.type = 'button'; save.textContent = 'Save current filling'; save.addEventListener('click', () => void saveCurrent(controller)); controller.menu.append(save);
  const manage = document.createElement('button'); manage.className = 'menu-item action'; manage.type = 'button'; manage.textContent = 'Manage fillings for this form'; manage.addEventListener('click', () => void openLibrary()); controller.menu.append(manage);
}
function previewFill(controller: FormController, match: MatchSummary): void { controller.menu.replaceChildren(); const heading = document.createElement('div'); heading.className = 'menu-heading'; heading.textContent = `Preview: ${match.name}`; controller.menu.append(heading); const current = new Map(snapshot(controller.form).fields.map((field) => [field.descriptor.key, currentSummary(field)])); for (const field of match.preview) { const row = document.createElement('div'); row.className = 'notice'; const changed = current.get(field.key); row.textContent = `${field.label}: ${field.value}${changed && changed !== field.value ? ` (replaces ${changed})` : ''}`; controller.menu.append(row); } const fillButton = document.createElement('button'); fillButton.className = 'menu-item action'; fillButton.type = 'button'; fillButton.textContent = 'Fill these values'; fillButton.addEventListener('click', () => void fill(controller, match.id)); const cancel = document.createElement('button'); cancel.className = 'menu-item action'; cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => renderMenu(controller)); controller.menu.append(fillButton, cancel); }
function closeSubmissionPrompt(host: HTMLDivElement): void { host.remove(); }
function createSubmissionPrompt(draftId: string, form: FormIdentity): void {
  if (pendingPromptShown) return;
  pendingPromptShown = true;
  const host = document.createElement('div'); host.className = 'form-filler-submission-prompt'; host.style.position = 'fixed'; host.style.top = '16px'; host.style.right = '16px'; host.style.zIndex = '2147483647'; host.style.pointerEvents = 'auto';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = `:host{all:initial;font-family:system-ui,sans-serif;color:#172033}.card{width:320px;padding:8px;border:1px solid #fbbf24;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003}.heading{padding:8px 9px;font-size:14px;font-weight:700}.notice{padding:4px 9px 10px;color:#475569;font-size:13px;line-height:1.4}.actions{display:grid;gap:4px}.action{display:block;width:100%;border:0;border-top:1px solid #eef2f7;border-radius:6px;padding:9px;background:#fff;color:#3730a3;text-align:left;cursor:pointer}.action:hover{background:#eef2ff}.action:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}.secondary{color:#475569;font-size:12px}`;
  const card = document.createElement('div'); card.className = 'card'; const heading = document.createElement('div'); heading.className = 'heading'; heading.textContent = 'Save this filling?'; const notice = document.createElement('div'); notice.className = 'notice'; notice.textContent = 'A submission attempt was detected. Choose what to do with the captured values.'; const actions = document.createElement('div'); actions.className = 'actions';
  const finish = (): void => closeSubmissionPrompt(host);
  const review = document.createElement('button'); review.className = 'action'; review.type = 'button'; review.textContent = 'Review and save'; review.addEventListener('click', () => { finish(); void request<any>({ type: 'OPEN_LIBRARY', requestId: newRequestId(), draftId }); });
  const dismiss = document.createElement('button'); dismiss.className = 'action secondary'; dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.addEventListener('click', () => { finish(); void request<any>({ type: 'DISMISS_DRAFT', requestId: newRequestId(), id: draftId }); });
  const never = document.createElement('button'); never.className = 'action secondary'; never.type = 'button'; never.textContent = 'Never offer for this form'; never.addEventListener('click', () => { finish(); void request<any>({ type: 'IGNORE_FORM', requestId: newRequestId(), form }).then(() => request<any>({ type: 'DISMISS_DRAFT', requestId: newRequestId(), id: draftId })); });
  window.setTimeout(finish, 10_000);
  actions.append(review, dismiss, never); card.append(heading, notice, actions); shadow.append(style, card); document.documentElement.append(host);
}
async function showPendingSubmissionPrompt(attempt = 0): Promise<void> {
  if (!vaultUnlocked || pendingPromptShown) return;
  const response = await request<any>({ type: 'GET_PENDING_SUBMISSION', requestId: newRequestId(), origin: location.origin });
  if (response.ok && response.draftId && response.pendingForm) createSubmissionPrompt(response.draftId, response.pendingForm);
  else if (attempt < 10) window.setTimeout(() => { void showPendingSubmissionPrompt(attempt + 1); }, 200);
}
function escapeHtml(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
async function refreshMatches(controller: FormController): Promise<void> { if (!vaultUnlocked) { controller.matches = []; renderMenu(controller); return; } const current = snapshot(controller.form); debugLog('matches.requested', { form: { index: current.form.formIndex, id: current.form.formId || '(none)', name: current.form.formName || '(none)', pathname: current.form.pathname, fingerprint: current.form.fingerprint }, controls: controlsFor(controller.form).map(controlTrace), serializedFields: current.fields.map(fieldTrace) }); const response = await request<any>({ type: 'LIST_MATCHES', requestId: newRequestId(), form: current.form, fields: current.fields }); if (response.ok) { controller.matches = response.matches ?? []; debugLog('matches.listed', { formIndex: current.form.formIndex, fingerprint: current.form.fingerprint, count: controller.matches.length, matches: controller.matches.map((match) => ({ id: match.id, name: match.name, fieldCount: match.fieldCount })) }); renderMenu(controller); } else debugLog('matches.error', { formIndex: current.form.formIndex, message: response.error }); }
async function fill(controller: FormController, id: string): Promise<void> { close(controller); setStatus(controller, 'Filling…'); const current = snapshot(controller.form); const form = current.form; const selected = controller.matches.find((match) => match.id === id); const fieldsByKey = new Map(current.fields.map((field) => [field.descriptor.key, field])); const savedFieldsByKey = new Map(selected?.preview.map((field) => [field.key, field]) ?? []); const savedFieldTrace = (field: MatchSummary['preview'][number]) => ({ resultKey: field.key, kind: field.kind, matchKeys: field.matchKeys, id: field.id || '(none)', name: field.name || '(none)', label: field.label || '(none)', position: field.index }); debugLog('fill.requested', { entry: { id, name: selected?.name ?? '(unknown)', savedFieldCount: selected?.fieldCount }, targetForm: formTrace(form), intendedSavedFields: selected?.preview.map(savedFieldTrace) ?? [], currentFields: current.fields.map(fieldTrace) }); const response = await request<any>({ type: 'START_FILL', requestId: newRequestId(), id, form, fields: current.fields }); if (!response.ok) { debugLog('fill.error', { entryId: id, targetForm: formTrace(form), message: response.error }); setStatus(controller, response.error); return; } const fillResult = response.fill; debugLog('fill.completed', { entry: { id, name: selected?.name ?? '(unknown)' }, targetForm: formTrace(form), status: fillResult.status, fieldCount: fillResult.fields.length, fields: fillResult.fields.map((field: any, resultIndex: number) => { const expected = savedFieldsByKey.get(field.key); const currentExactKey = fieldsByKey.get(field.key); return { resultIndex, resultKey: field.key, status: field.status, message: field.message, expectedSavedField: expected ? savedFieldTrace(expected) : '(not found in selected preview)', currentExactKeyField: currentExactKey ? fieldTrace(currentExactKey) : '(none; see worker field.match for independent lookup attempts)' }; }), failedCount: fillResult.fields.filter((field: any) => !['filled', 'unchanged'].includes(field.status)).length }); showFillResult(controller, fillResult); await refreshMatches(controller); }
async function saveCurrent(controller: FormController): Promise<void> { close(controller); const captured = snapshot(controller.form); debugLog('capture.requested', { formIndex: captured.form.formIndex, fieldCount: captured.fields.length, serializedFields: captured.fields.map(fieldTrace) }); const response = await request<any>({ type: 'CAPTURE_FORM', requestId: newRequestId(), form: captured, saveDraft: true }); if (!response.ok) { debugLog('capture.error', { formIndex: captured.form.formIndex, message: response.error }); setStatus(controller, response.error); return; } debugLog('capture.completed', { formIndex: captured.form.formIndex, draftCreated: !!response.draftId }); await request<any>({ type: 'OPEN_LIBRARY', requestId: newRequestId(), draftId: response.draftId }); }
async function openLibrary(): Promise<void> { await request<any>({ type: 'OPEN_LIBRARY', requestId: newRequestId() }); }
function buildController(form: HTMLFormElement): FormController {
  const host = document.createElement('div'); host.className = 'form-filler-host'; host.style.position = 'fixed'; host.style.zIndex = '2147483646'; host.style.pointerEvents = 'auto'; const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = `:host{all:initial;font-family:system-ui,sans-serif;color:#172033}.wrap{position:relative}.trigger{width:32px;height:30px;border:1px solid #c7d2fe;border-radius:7px;background:#fff;color:#3730a3;box-shadow:0 2px 8px #0002;cursor:grab;font-size:16px;opacity:.4;transition:opacity .15s ease;touch-action:none}.trigger:active{cursor:grabbing}.trigger:hover,.trigger:focus-visible,.trigger[aria-expanded=true]{opacity:1}.trigger:focus-visible,.menu-item:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}.menu{position:absolute;right:0;top:36px;width:260px;max-height:340px;overflow:auto;padding:6px;border:1px solid #dbe1ea;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003;z-index:2147483647}.menu-item{display:flex;width:100%;align-items:flex-start;gap:8px;flex-direction:column;border:0;border-radius:7px;padding:9px;background:#fff;text-align:left;cursor:pointer}.menu-item:hover{background:#eef2ff}.menu-item small{color:#64748b}.action{border-top:1px solid #eef2f7;border-radius:0;color:#3730a3}.menu-heading{padding:6px 9px;font-size:12px;font-weight:700;color:#475569}.notice{padding:10px;color:#475569;font-size:13px}.status{position:absolute;right:0;top:calc(100% + 344px);width:260px;padding:7px;border-radius:7px;background:#172033;color:#fff;font-size:12px}`;
  const wrap = document.createElement('div'); wrap.className = 'wrap'; const button = document.createElement('button'); button.className = 'trigger'; button.type = 'button'; button.title = 'Form Filler'; button.setAttribute('aria-label', 'Form Filler menu'); button.setAttribute('aria-expanded', 'false'); button.textContent = '✦'; const menu = document.createElement('div'); menu.className = 'menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); const status = document.createElement('div'); status.className = 'status'; status.hidden = true; wrap.append(button, menu, status); shadow.append(style, wrap); document.documentElement.append(host);
  const controller = { form, host, button, menu, status, matches: [], dragged: false };
  button.addEventListener('click', () => { if (button.dataset.dragged) { delete button.dataset.dragged; return; } if (menu.hidden) { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); void refreshMatches(controller); } else close(controller); }); enableDragging(controller); shadow.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') { close(controller); button.focus(); } });
  position(controller); renderMenu(controller); return controller;
}
function discover(): void { for (const form of Array.from(document.forms)) if (!controllers.has(form)) controllers.set(form, buildController(form)); for (const [form, controller] of controllers) if (!document.contains(form)) { controller.host.remove(); controllers.delete(form); } for (const controller of controllers.values()) position(controller); }
function handleSubmit(event: Event): void {
  const form = event.target instanceof HTMLFormElement ? event.target : undefined;
  if (!form) return;
  const controller = controllers.get(form);
  if (!vaultUnlocked) { debugLog('submission.ignored', { reason: 'vault-locked' }); if (controller) setStatus(controller, 'Unlock the vault before submitting to enable save offers.'); return; }
  const captured = snapshot(form);
  const observe = () => {
    debugLog('submission.detected', { formIndex: captured.form.formIndex, fieldCount: captured.fields.length });
    return request<any>({ type: 'SUBMISSION_OBSERVED', requestId: newRequestId(), form: captured });
  };
  const hasFiles = captured.fields.some((field) => field.value.tag === 'file' && field.value.files.length > 0);
  if (delaySubmission(event, form, observe, (outcome) => debugLog('submission.resumed', { outcome }), hasFiles)) return;
  void observe();
}
async function boot(): Promise<void> {
  let receivedVaultState = false;
  chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'DEBUG_STATE') { debugEnabled = !!message.enabled; debugLog('debug.enabled', { enabled: debugEnabled }); return; } if (message?.type === 'VAULT_STATE') { receivedVaultState = true; vaultUnlocked = !!message.unlocked; debugLog('vault.state', { unlocked: vaultUnlocked }); for (const controller of controllers.values()) { renderMenu(controller); if (!vaultUnlocked) setStatus(controller, 'Vault locked.'); } } });
  document.addEventListener('submit', handleSubmit, true);
  const initial = await request<any>({ type: 'GET_SITE_STATUS', requestId: newRequestId() }); if (!initial.ok || !initial.status?.enabled) return; if (!receivedVaultState) vaultUnlocked = !!initial.status.unlocked; debugEnabled = !!initial.status.debug; debugLog('boot', { origin: location.origin, formCount: document.forms.length, vaultUnlocked }); discover(); void showPendingSubmissionPrompt();
  const observer = new MutationObserver(() => { window.clearTimeout((observer as any)._timer); (observer as any)._timer = window.setTimeout(discover, 150); }); observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', () => { for (const controller of controllers.values()) position(controller); }, { passive: true }); addEventListener('resize', () => { for (const controller of controllers.values()) position(controller); });
  document.addEventListener('input', () => { revision += 1; }, true); document.addEventListener('change', () => { revision += 1; }, true);
}
})();
