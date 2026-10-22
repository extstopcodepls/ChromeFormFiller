import type { CapturedField, FillFieldResult, FillResult, FormIdentity, FormSnapshot, SavedFilling } from './types';
import { fieldMatchKeys } from './matching';
import { normalizeWaitAfterFillMs, waitAfterFill } from './delay';

type Cdp = (method: string, params?: Record<string, unknown>) => Promise<any>;
type ReplayLogger = (event: string, details?: Record<string, unknown>) => void;

function jsString(value: string): string { return JSON.stringify(value); }
function safeDebugReason(message: string): string { return /(?:[A-Za-z]:\\|\\\\)/.test(message) ? 'The browser reported an error containing a local path.' : message; }
function formLocator(form?: FormIdentity): string {
  if (!form) return 'null';
  const candidates: string[] = [];
  // The caller supplies a fresh snapshot of the form the user clicked. Its
  // current document position is therefore a stronger locator than an id/name,
  // both of which are frequently duplicated by component frameworks.
  if (form.formIndex !== undefined && form.formIndex >= 0) candidates.push(`document.forms[${form.formIndex}]`);
  if (form.formId) candidates.push(`document.getElementById(${jsString(form.formId)})`);
  if (form.formName) candidates.push(`Array.from(document.forms).find((item)=>item.name===${jsString(form.formName)})`);
  return `(function(){const candidates=[${candidates.join(',')}];return candidates.find((item)=>item&&item.tagName==='FORM')||null})()`;
}
function locator(field: CapturedField, form?: FormIdentity): string {
  const d = field.descriptor;
  const targetForm = formLocator(form ?? (d.formId || d.formName ? { origin: '', pathname: '', formId: d.formId ?? '', formName: d.formName ?? '', actionOrigin: '', actionPath: '', method: '', fingerprint: '' } : undefined));
  const controls = `Array.from(document.querySelectorAll('input,textarea,select')).filter((item)=>item.form===form)`;
  const kind = jsString(d.kind);
  const keys = JSON.stringify(fieldMatchKeys(d));
  const compatible = `function compatible(item){if(!item||item.form!==form)return false;const kind=${kind};const actual=item.tagName==='TEXTAREA'?'textarea':item.tagName==='SELECT'?(item.multiple?'select-multiple':'select-one'):item.tagName==='INPUT'?item.type.toLowerCase():'';const textKinds=['text','search','email','url','tel','textarea','number','date','time','month','week','datetime-local'];return actual===kind||(textKinds.includes(actual)&&textKinds.includes(kind))}`;
  const labelOf = `function labelOf(item){const labelledBy=(item.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.textContent||'').filter(Boolean).join(' ');const text=item.labels&&Array.from(item.labels).map((label)=>label.textContent||'').join(' ')||labelledBy||item.getAttribute('aria-label')||item.getAttribute('placeholder')||'';return text.replace(/\\s+/g,' ').trim().toLowerCase()}`;
  const keyMatcher = `function matchesKey(item,key){if(key.strategy==='id')return item.id===key.value;if(key.strategy==='name')return item.name===key.value;if(key.strategy==='label')return labelOf(item)===String(key.value).replace(/\\s+/g,' ').trim().toLowerCase();return controls.indexOf(item)===key.value}`;
  return `(function(){const form=${targetForm};if(!form)return null;const controls=${controls};const keys=${keys};${compatible}${labelOf}${keyMatcher}for(const key of keys){const candidates=controls.filter((item)=>compatible(item)&&matchesKey(item,key));if(candidates.length===1)return candidates[0];}return null})()`;
}
function guardedLocator(field: CapturedField, form?: FormIdentity): string {
  return `(function(){const e=${locator(field, form)};return e&&e.form?e:null})()`;
}
function locatorTraceExpression(field: CapturedField, form: FormIdentity): string {
  const d = field.descriptor;
  const id = jsString(d.id);
  const name = jsString(d.name);
  const label = jsString(d.label.trim().replace(/\s+/g, ' ').toLowerCase());
  const kind = jsString(d.kind);
  const serializedKeys = JSON.stringify(fieldMatchKeys(d));
  const formId = jsString(form.formId);
  const formName = jsString(form.formName);
  const formIndex = form.formIndex ?? -1;
  return `(function(){
    const serializedKeys=${serializedKeys};
    const formAttempts=[];let form=null;let formDecision='missing';
    function tryForm(strategy,candidate){const valid=!!candidate&&candidate.tagName==='FORM';formAttempts.push({strategy,found:!!candidate,tag:candidate&&candidate.tagName||null,valid});if(!form&&valid){form=candidate;formDecision=strategy;}}
    ${formIndex >= 0 ? `tryForm('position',document.forms[${formIndex}]);` : `formAttempts.push({strategy:'position',skipped:true,reason:'saved form has no position'});`}
    ${form.formId ? `tryForm('id',document.getElementById(${formId}));` : `formAttempts.push({strategy:'id',skipped:true,reason:'saved form has no id'});`}
    ${form.formName ? `tryForm('name',Array.from(document.forms).find((item)=>item.name===${formName}));` : `formAttempts.push({strategy:'name',skipped:true,reason:'saved form has no name'});`}
    if(!form)return {matched:false,decision:'form-missing',formDecision,formAttempts,controlCount:0,saved:{resultKey:${jsString(d.key)},kind:${kind},id:${id}||'(none)',name:${name}||'(none)',label:${label}||'(none)',position:${d.index},serializedKeys},attempts:serializedKeys.map((key)=>({strategy:key.strategy,expected:key.value,compatibleMatches:0,candidates:[],unique:false,reason:'form missing'}))};
    const controls=Array.from(document.querySelectorAll('input,textarea,select')).filter((item)=>item.form===form);
    function actualKind(item){if(item.tagName==='TEXTAREA')return 'textarea';if(item.tagName==='SELECT')return item.multiple?'select-multiple':'select-one';return item.type.toLowerCase();}
    function compatible(item){if(!item||item.form!==form)return false;const actual=actualKind(item);const saved=${kind};const textKinds=['text','search','email','url','tel','textarea','number','date','time','month','week','datetime-local'];return actual===saved||(textKinds.includes(actual)&&textKinds.includes(saved));}
    function labelOf(item){const labelledBy=(item.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map((id)=>document.getElementById(id)?.textContent||'').filter(Boolean).join(' ');const text=item.labels&&Array.from(item.labels).map((label)=>label.textContent||'').join(' ')||labelledBy||item.getAttribute('aria-label')||item.getAttribute('placeholder')||'';return text.replace(/\\s+/g,' ').trim().toLowerCase();}
    function matchesKey(item,key){if(key.strategy==='id')return item.id===key.value;if(key.strategy==='name')return item.name===key.value;if(key.strategy==='label')return labelOf(item)===String(key.value).replace(/\\s+/g,' ').trim().toLowerCase();return controls.indexOf(item)===key.value;}
    function summary(item){const position=controls.indexOf(item);return item?{fieldIndex:position,position,kind:actualKind(item),id:item.id||'(none)',name:item.name||'(none)',label:labelOf(item)||'(none)'}:null;}
    const attempts=[];let element=null;let decision='missing';
    function choose(strategy,candidates,expected){attempts.push({strategy,expected,compatibleMatches:candidates.length,candidates:candidates.map(summary),unique:candidates.length===1});if(!element&&candidates.length===1){element=candidates[0];decision=strategy;}}
    for(const key of serializedKeys)choose(key.strategy,controls.filter((item)=>compatible(item)&&matchesKey(item,key)),key.value);
    return {matched:!!element,decision,formDecision,formAttempts,controlCount:controls.length,saved:{resultKey:${jsString(d.key)},kind:${kind},id:${id}||'(none)',name:${name}||'(none)',label:${label}||'(none)',position:${d.index},serializedKeys},selected:summary(element),attempts};
  })()`;
}
function isText(kind: string): boolean { return ['text','search','email','url','tel','textarea','number','range','date','time','month','week','datetime-local'].includes(kind); }
function displayFieldName(field: CapturedField, fieldIndex: number): string {
  return field.descriptor.label.trim() || field.descriptor.name.trim() || field.descriptor.id.trim() || `${field.descriptor.kind} field ${fieldIndex + 1}`;
}
function fieldResult(field: CapturedField, fieldIndex: number, status: FillFieldResult['status'], message?: string): FillFieldResult {
  return { key: field.descriptor.key, fieldName: displayFieldName(field, fieldIndex), status, message };
}
function result(status: FillResult['status'], fields: FillFieldResult[], message?: string): FillResult { return { status, fields, message }; }
async function waitAfterVerifiedField(field: CapturedField, filling: SavedFilling, fieldIndex: number, isCanceled: () => boolean, log: ReplayLogger): Promise<boolean> {
  const waitMs = normalizeWaitAfterFillMs(field.waitAfterFillMs, normalizeWaitAfterFillMs(filling.waitAfterFillMs));
  if (waitMs === 0) return true;
  log('wait.start', { fieldIndex, delayMs: waitMs, overridden: field.waitAfterFillMs !== undefined });
  const completed = await waitAfterFill(waitMs, isCanceled);
  if (!completed) { log('wait.canceled', { fieldIndex, delayMs: waitMs }); return false; }
  log('wait.complete', { fieldIndex, delayMs: waitMs });
  return true;
}

async function nodeFor(cdp: Cdp, field: CapturedField, form: FormIdentity): Promise<number | undefined> {
  const evaluated = await cdp('Runtime.evaluate', { expression: guardedLocator(field, form), objectGroup: 'form-filler', returnByValue: false, awaitPromise: false });
  const objectId = evaluated.result?.objectId;
  if (!objectId) return undefined;
  try {
    const requested = await cdp('DOM.requestNode', { objectId });
    const requestedNodeId = requested?.nodeId ?? requested?.result?.nodeId;
    if (typeof requestedNodeId === 'number' && requestedNodeId > 0) return requestedNodeId;

    // Some Chrome/debugger combinations return nodeId 0 for a live Runtime
    // object even though it is a DOM node. Resolve the backend identity and
    // explicitly push it into the DOM agent's frontend tree instead.
    const described = await cdp('DOM.describeNode', { objectId });
    const backendNodeId = described.node?.backendNodeId ?? described.result?.node?.backendNodeId;
    if (typeof backendNodeId !== 'number' || backendNodeId <= 0) return undefined;
    const pushed = await cdp('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
    const nodeId = pushed.nodeIds?.[0] ?? pushed.result?.nodeIds?.[0];
    return typeof nodeId === 'number' && nodeId > 0 ? nodeId : undefined;
  } finally {
    await cdp('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}
async function describe(cdp: Cdp, field: CapturedField, form: FormIdentity): Promise<{ value: string; checked?: boolean; selected?: string[]; files?: string[] } | undefined> {
  const expression = `(function(){const e=${guardedLocator(field, form)};if(!e)return null;return {value:e.value||'',checked:e.checked,selected:e instanceof HTMLSelectElement?Array.from(e.selectedOptions).map(x=>x.value):undefined,files:e.files?Array.from(e.files).map(x=>x.name):undefined}})()`;
  const reply = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  return reply.result?.value ?? undefined;
}

/** Uses only browser-provided File remote objects; page content never supplies paths. */
export async function captureFilePaths(cdp: Cdp, snapshot: FormSnapshot): Promise<FormSnapshot> {
  const fields = snapshot.fields.map((field) => ({ ...field, value: field.value.tag === 'file' ? { ...field.value, files: field.value.files.map((file) => ({ ...file })) } : field.value }));
  for (const field of fields) {
    if (field.descriptor.kind !== 'file' || field.value.tag !== 'file' || !field.value.files.length) continue;
    try {
      const evaluated = await cdp('Runtime.evaluate', { expression: guardedLocator(field, snapshot.form), objectGroup: 'form-filler-file-capture', returnByValue: false });
      const inputObjectId = evaluated.result?.objectId;
      if (!inputObjectId) continue;
      const inputProperties = await cdp('Runtime.getProperties', { objectId: inputObjectId, ownProperties: false });
      const filesProperty = inputProperties.result?.find((property: any) => property.name === 'files')?.value?.objectId;
      if (!filesProperty) continue;
      const fileListProperties = await cdp('Runtime.getProperties', { objectId: filesProperty, ownProperties: false });
      const fileObjects = fileListProperties.result?.filter((property: any) => /^\d+$/.test(property.name)).map((property: any) => property.value?.objectId).filter(Boolean) ?? [];
      const captured = [] as Array<{ path: string; name: string; size?: number; lastModified?: number }>;
      for (const fileObjectId of fileObjects) {
        const info = await cdp('DOM.getFileInfo', { objectId: fileObjectId });
        const path = typeof info?.path === 'string' ? info.path : '';
        if (/^(?:[A-Za-z]:\\|\\\\)/.test(path)) captured.push({ path, name: field.value.files[captured.length]?.name ?? 'file', size: field.value.files[captured.length]?.size, lastModified: field.value.files[captured.length]?.lastModified });
      }
      if (captured.length === field.value.files.length) field.value.files = captured;
      await cdp('Runtime.releaseObject', { objectId: inputObjectId }).catch(() => undefined);
    } catch {
      // DOM.getFileInfo is experimental. Preserve the metadata and require reselection.
    }
  }
  return { ...snapshot, fields };
}
/**
 * Set a form control through the DOM exposed by the debugger. Using the
 * native prototype setters matters for controlled inputs (React in
 * particular), while the events make the change visible to page listeners.
 * No focus, mouse, or keyboard input is needed for any of these controls.
 */
async function setControlValue(cdp: Cdp, field: CapturedField, form: FormIdentity): Promise<boolean> {
  const value = field.value;
  const kind = field.descriptor.kind;
  const serializedValue = JSON.stringify(value);
  const expression = `(function(){
    const e=${guardedLocator(field, form)};
    if(!e)return false;
    const value=${serializedValue};
    const fire=(type)=>e.dispatchEvent(new Event(type,{bubbles:true,composed:true}));
    if(${jsString(kind)}==='checkbox'){
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked')?.set;
      if(!setter)return false;
      setter.call(e,!!value.value);
      e.indeterminate=false;
    }else if(${jsString(kind)}==='radio'){
      if(value.value===null)return true;
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked')?.set;
      if(!setter)return false;
      setter.call(e,true);
      e.indeterminate=false;
    }else if(${jsString(kind)}==='select-one'||${jsString(kind)}==='select-multiple'){
      const values=new Set(value.values);
      if(e.multiple){
        for(const option of e.options)option.selected=values.has(option.value);
      }else{
        const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')?.set;
        if(!setter)return false;
        setter.call(e,value.values[0]??'');
      }
    }else{
      const setter=e instanceof HTMLTextAreaElement
        ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(!setter)return false;
      setter.call(e,value.value);
    }
    fire('input');
    fire('change');
    return true;
  })()`;
  const reply = await cdp('Runtime.evaluate', { expression, objectGroup: 'form-filler-set-control', returnByValue: true, awaitPromise: false });
  return reply.result?.value === true;
}

export async function replay(cdp: Cdp, filling: SavedFilling, isCanceled: () => boolean, log: ReplayLogger = () => undefined, traceMatching = false): Promise<FillResult> {
  const fields: FillFieldResult[] = [];
  const deadline = Date.now() + 120_000;
  const includedFields = filling.fields.filter((item) => item.included);
  log('start', { entryId: filling.id, fieldCount: includedFields.length });
  for (const [fieldIndex, field] of includedFields.entries()) {
    log('field.start', { fieldIndex, resultKey: field.descriptor.key, kind: field.descriptor.kind, serializedKeys: fieldMatchKeys(field.descriptor) });
    if (isCanceled()) { fields.push(fieldResult(field, fieldIndex, 'canceled')); return result('canceled', fields); }
    if (Date.now() > deadline) return result('partial', fields, 'The two-minute replay limit was reached.');
    const kind = field.descriptor.kind;
    try {
      if (traceMatching) {
        const trace = await cdp('Runtime.evaluate', { expression: locatorTraceExpression(field, filling.form), returnByValue: true, awaitPromise: false });
        log('field.match', { fieldIndex, ...(trace.result?.value ?? { matched: false, decision: 'diagnostic-unavailable' }) });
      }
      const current = await describe(cdp, field, filling.form);
      const value = field.value;
      if (kind === 'file') {
        const nodeId = await nodeFor(cdp, field, filling.form);
        if (!nodeId) { const message = 'Control could not be resolved inside the saved form.'; log('field.missing', { fieldIndex, reason: message }); fields.push(fieldResult(field, fieldIndex, 'missing', message)); continue; }
        const files = field.value.tag === 'file' ? field.value.files : [];
        const paths = files.map((file) => file.path).filter((path): path is string => typeof path === 'string' && /^(?:[A-Za-z]:\\|\\\\)/.test(path));
        if (paths.length !== files.length) { const message = 'File reselection is required because Chrome did not expose a reusable local path.'; log('field.manual', { fieldIndex, reason: message }); fields.push(fieldResult(field, fieldIndex, 'manual', message)); continue; }
        await cdp('DOM.setFileInputFiles', { nodeId, files: paths });
        const afterFiles = (await describe(cdp, field, filling.form))?.files ?? [];
        const wantedFiles = files.map((file) => file.name);
        const verified = JSON.stringify(afterFiles) === JSON.stringify(wantedFiles);
        fields.push(fieldResult(field, fieldIndex, verified ? 'filled' : 'failed', verified ? undefined : 'The selected file list could not be verified.'));
        if (verified && !await waitAfterVerifiedField(field, filling, fieldIndex, isCanceled, log)) return result('canceled', fields, 'Filling canceled during the configured wait.');
        continue;
      }
      if (kind === 'radio' && value.tag === 'radio' && value.value === null) {
        const message = 'No selection was saved for this radio option.';
        log('field.unchanged', { fieldIndex, reason: message });
        fields.push(fieldResult(field, fieldIndex, 'unchanged', message));
        continue;
      }
      if (!isText(kind) && kind !== 'checkbox' && kind !== 'radio' && kind !== 'select-one' && kind !== 'select-multiple' && kind !== 'color') {
        const message = 'This control is not supported by the DOM adapter.'; log('field.manual', { fieldIndex, reason: message }); fields.push(fieldResult(field, fieldIndex, 'manual', message));
        continue;
      }
      if (!await setControlValue(cdp, field, filling.form)) {
        const message = 'The control could not be set through the page DOM.'; log('field.failed', { fieldIndex, reason: message }); fields.push(fieldResult(field, fieldIndex, 'failed', message)); continue;
      }
      const after = await describe(cdp, field, filling.form);
      const wanted = value.tag === 'boolean' ? String(value.value) : value.tag === 'radio' ? value.value ?? '' : value.tag === 'options' ? JSON.stringify(value.values) : value.tag === 'text' ? value.value : JSON.stringify(value);
      const actual = kind === 'checkbox' ? String(after?.checked) : kind === 'radio' ? (after?.checked ? after.value : '') : kind === 'select-one' || kind === 'select-multiple' ? JSON.stringify(after?.selected ?? []) : after?.value ?? '';
      const verified = actual === wanted; const status = verified ? 'filled' : 'failed'; const message = status === 'filled' ? undefined : 'DOM update completed, but verification reported a different value.'; log(`field.${status}`, { fieldIndex, reason: message }); fields.push(fieldResult(field, fieldIndex, status, message));
      if (verified && !await waitAfterVerifiedField(field, filling, fieldIndex, isCanceled, log)) return result('canceled', fields, 'Filling canceled during the configured wait.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Replay failed.'; log('field.failed', { fieldIndex, reason: safeDebugReason(message) }); fields.push(fieldResult(field, fieldIndex, 'failed', message));
    }
  }
  const status = fields.some((f) => ['missing','manual','failed'].includes(f.status)) ? 'partial' : 'completed';
  return result(status, fields);
}
