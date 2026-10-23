import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Element {
  children: Element[] = [];
  parent?: Element;
  style = {};
  dataset = {};
  textContent = '';
  innerHTML = '';
  hidden = false;
  className = '';
  id = '';
  name = '';
  tagName = 'INPUT';
  listeners = new Map<string, (event?: unknown) => void>();
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute() {}
  getAttribute() { return null; }
  addEventListener(event: string, listener: (event?: unknown) => void) { this.listeners.set(event, listener); }
  attachShadow() { const shadow = new Element(); this.append(shadow); return shadow; }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}
class Form extends Element { method = 'post'; }
class Input extends Element {
  form: Form;
  value = '';
  checked = false;
  disabled = false;
  readOnly = false;
  type = 'text';
  files: Array<{ name: string; size: number; lastModified: number }> = [];
  labels = [];
  constructor(form: Form, name: string) { super(); this.form = form; this.name = name; }
}
class Textarea extends Input {}
class Select extends Input {
  multiple = false;
  options = [{ value: 'one', textContent: 'One' }, { value: 'two', textContent: 'Two' }];
  selectedOptions = [this.options[0]];
}

describe('content script filling provenance', () => {
  let root: Element;
  let form: Form;
  let otherForm: Form;
  let text: Input;
  let checkbox: Input;
  let file: Input;
  let select: Select;
  let notes: Textarea;
  let radio: Input;
  let controls: Input[];
  let listeners: Map<string, (event: unknown) => void>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let replay: () => void;
  let fillResponse: Record<string, unknown>;
  let draftNumber: number;

  const find = (label: string) => root.all().find((node) => node.textContent === label);
  const click = (label: string) => { const button = find(label); expect(button, label).toBeDefined(); button!.listeners.get('click')!(); };
  const messages = (type: string) => sendMessage.mock.calls.filter(([message]) => message.type === type);
  const edit = (control: Input, isTrusted = true) => listeners.get('input')!({ target: control, isTrusted });
  const submitEvent = (target = form) => Object.defineProperty(new Event('submit', { cancelable: true }), 'target', { value: target });
  const submit = (target = form) => listeners.get('submit')!(submitEvent(target));
  const fill = async () => {
    root.all().find((node) => node.className === 'trigger')!.listeners.get('click')!();
    await vi.waitFor(() => expect(root.all().some((node) => node.innerHTML.includes('Saved test'))).toBe(true));
    root.all().find((node) => node.innerHTML.includes('Saved test'))!.listeners.get('click')!();
    click('Fill these values');
    await vi.waitFor(() => expect(find('Filling verified.') ?? find('Completed with 1 manual/failed field.')).toBeDefined());
    await Promise.resolve();
  };

  beforeEach(async () => {
    vi.resetModules();
    root = new Element(); form = new Form(); otherForm = new Form();
    text = new Input(form, 'company'); checkbox = new Input(form, 'agree'); checkbox.type = 'checkbox';
    file = new Input(form, 'attachment'); file.type = 'file'; select = new Select(form, 'category');
    notes = new Textarea(form, 'notes'); radio = new Input(form, 'choice'); radio.type = 'radio'; radio.value = 'yes';
    controls = [text, checkbox, file, select, notes, radio, new Input(otherForm, 'other')];
    listeners = new Map(); draftNumber = 0;
    fillResponse = { ok: true, fill: { status: 'completed', fields: [{ key: 'field-0', fieldName: 'Company', status: 'filled' }] } };
    replay = () => {
      text.value = 'Saved company'; checkbox.checked = true;
      file.files = [{ name: 'saved.pdf', size: 100, lastModified: 123 }];
      for (const control of controls.filter((control) => control.form === form)) edit(control, control === file);
    };
    sendMessage = vi.fn((message, callback) => {
      if (message.type === 'GET_SITE_STATUS') callback({ ok: true, status: { enabled: true, unlocked: true } });
      else if (message.type === 'LIST_MATCHES') callback({ ok: true, matches: [{ id: 'saved', name: 'Saved test', fieldCount: 1, preview: [] }] });
      else if (message.type === 'START_FILL') { replay(); callback(fillResponse); }
      else if (message.type === 'SUBMISSION_OBSERVED') callback({ ok: true, draftId: `draft-${++draftNumber}` });
      else callback({ ok: true });
    });
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() });
    vi.stubGlobal('location', { origin: 'https://example.test', href: 'https://example.test/form' });
    vi.stubGlobal('HTMLFormElement', Form); vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLTextAreaElement', Textarea); vi.stubGlobal('HTMLSelectElement', Select);
    vi.stubGlobal('document', {
      forms: [form, otherForm], documentElement: root, contains: () => true,
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      createElement: () => new Element(), createTextNode: (value: string) => Object.assign(new Element(), { textContent: value }),
      querySelectorAll: () => controls,
    });
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('MutationObserver', class { observe() {} });
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: vi.fn() } } });
    await import('../src/content');
    await vi.waitFor(() => expect(listeners.has('input')).toBe(true));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers review and save for a manual submission on the current page', async () => {
    text.value = 'Manual company'; edit(text); submit();
    await vi.waitFor(() => expect(find('Review and save')).toBeDefined());
    expect(messages('SUBMISSION_OBSERVED')[0][0].form.fields[0].value.value).toBe('Manual company');
    click('Review and save');
    expect(messages('OPEN_LIBRARY')[0][0].draftId).toBe('draft-1');
  });

  it('does not capture, delay submission, or offer saving for unchanged replay values', async () => {
    await fill();
    expect(find('Save current filling')).toBeDefined(); // The other form remains manually saveable.
    const firstHost = root.children[0];
    expect(firstHost.all().some((node) => node.textContent === 'Save current filling')).toBe(false);
    const event = submitEvent();
    listeners.get('submit')!(event); submit();
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(messages('SUBMISSION_OBSERVED')).toHaveLength(0);
    expect(find('Review and save')).toBeUndefined();
  });

  it('does not count no-op input and change events as edits', async () => {
    await fill(); edit(text); listeners.get('change')!({ target: checkbox, isTrusted: true }); submit();
    expect(messages('SUBMISSION_OBSERVED')).toHaveLength(0);
  });

  it.each(['text', 'checkbox', 'select', 'file', 'textarea', 'radio'])('offers a new filling after editing a replayed %s field', async (kind) => {
    await fill();
    let control: Input;
    if (kind === 'checkbox') { control = checkbox; checkbox.checked = false; }
    else if (kind === 'select') { control = select; select.selectedOptions = [select.options[1]]; }
    else if (kind === 'file') { control = file; file.files = [{ name: 'saved.pdf', size: 200, lastModified: 456 }]; }
    else if (kind === 'textarea') { control = notes; notes.value = 'Manual notes'; }
    else if (kind === 'radio') { control = radio; radio.checked = true; }
    else { control = text; text.value = 'Edited company'; }
    edit(control);
    expect(root.children[0].all().some((node) => node.textContent === 'Save current filling')).toBe(true);
    submit();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
    expect(find('Review and save')).toBeDefined();
  });

  it('keeps a user-edited filling new even when the user restores the original value', async () => {
    await fill(); text.value = 'Edited'; edit(text); text.value = 'Saved company'; edit(text); submit();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('checks final values even if the page did not emit an edit event', async () => {
    await fill(); text.value = 'Changed without event'; submit();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('tracks each form separately', async () => {
    await fill(); submit(otherForm);
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
    expect(messages('SUBMISSION_OBSERVED')[0][0].form.form.formIndex).toBe(1);
  });

  it('does not claim a rejected fill as extension-filled', async () => {
    fillResponse = { ok: false, error: 'Replay unavailable' }; replay = () => {};
    root.all().find((node) => node.className === 'trigger')!.listeners.get('click')!();
    await vi.waitFor(() => expect(root.all().some((node) => node.innerHTML.includes('Saved test'))).toBe(true));
    root.all().find((node) => node.innerHTML.includes('Saved test'))!.listeners.get('click')!(); click('Fill these values');
    await vi.waitFor(() => expect(find('Replay unavailable')).toBeDefined());
    submit(); await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('does not swallow trusted manual edits made while replay is in progress', async () => {
    const defaultReplay = replay;
    replay = () => { defaultReplay(); notes.value = 'Typed during replay'; edit(notes); };
    await fill(); submit();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('waits for an in-progress replay before deciding whether submission needs a draft', async () => {
    replay = () => { text.value = 'Saved company'; edit(text, false); submit(); };
    await fill();
    await Promise.resolve();
    expect(messages('SUBMISSION_OBSERVED')).toHaveLength(0);
    expect(find('Review and save')).toBeUndefined();
  });

  it('captures manual edits when submission arrives before replay replies', async () => {
    replay = () => { text.value = 'Typed while filling'; edit(text); submit(); };
    await fill();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
    expect(messages('SUBMISSION_OBSERVED')[0][0].form.fields[0].value.value).toBe('Typed while filling');
  });

  it('suppresses an untouched partial replay, then offers saving after manual completion', async () => {
    fillResponse = { ok: true, fill: { status: 'partial', fields: [
      { key: 'field-0', fieldName: 'Company', status: 'filled' },
      { key: 'field-4', fieldName: 'Notes', status: 'manual' },
    ] } };
    await fill(); submit(); expect(messages('SUBMISSION_OBSERVED')).toHaveLength(0);
    notes.value = 'Completed manually'; edit(notes); submit();
    await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('does not suppress saving when every replayed field failed', async () => {
    fillResponse = { ok: true, fill: { status: 'partial', fields: [{ key: 'field-0', fieldName: 'Company', status: 'failed' }] } };
    replay = () => {};
    await fill(); submit(); await vi.waitFor(() => expect(messages('SUBMISSION_OBSERVED')).toHaveLength(1));
  });

  it('starts tracking again when a user-edited form is filled again', async () => {
    await fill(); text.value = 'Edited'; edit(text);
    await fill(); submit(); expect(messages('SUBMISSION_OBSERVED')).toHaveLength(0);
  });

  it('offers review again for a later manual submission after dismissal', async () => {
    submit(); await vi.waitFor(() => expect(find('Dismiss')).toBeDefined()); click('Dismiss');
    expect(find('Review and save')).toBeUndefined();
    text.value = 'Next filling'; edit(text); submit();
    await vi.waitFor(() => expect(find('Review and save')).toBeDefined());
    click('Review and save'); expect(messages('OPEN_LIBRARY')[0][0].draftId).toBe('draft-2');
  });
});
