import type { CapturedField, ControlKind, FieldDescriptor, FieldMatchKey, FieldMatchStrategy, FormIdentity, FormSnapshot, SavedFilling } from './types';

interface FieldCandidateSummary {
  fieldIndex: number;
  kind: ControlKind;
  id: string;
  name: string;
  label: string;
  position: number;
}

export interface FieldKeyAttempt {
  strategy: FieldMatchStrategy;
  expected: string | number;
  compatibleMatches: number;
  candidates: FieldCandidateSummary[];
  unique: boolean;
}

export interface FieldMatchTrace {
  savedFieldIndex: number;
  resultKey: string;
  included: boolean;
  savedKind: ControlKind;
  serializedKeys: FieldMatchKey[];
  matched: boolean;
  decision: FieldMatchStrategy | 'missing' | 'excluded';
  selected?: FieldCandidateSummary;
  attempts: FieldKeyAttempt[];
}

export interface SnapshotMatchTrace {
  matched: boolean;
  form: {
    origin: boolean;
    pathname: boolean;
    fingerprint: boolean;
    formId: 'match' | 'different' | 'unavailable';
    formName: 'match' | 'different' | 'unavailable';
    position: 'match' | 'different' | 'unavailable';
    metadataCompatible: boolean;
  };
  structure: {
    used: boolean;
    compatible: boolean;
    savedFieldCount: number;
    currentFieldCount: number;
    fields: FieldMatchTrace[];
  };
}

const strategyOrder: FieldMatchStrategy[] = ['id', 'name', 'label', 'position'];
const textLikeKinds = new Set<ControlKind>(['text', 'search', 'email', 'url', 'tel', 'textarea', 'number', 'date', 'time', 'month', 'week', 'datetime-local']);

function sameFormMetadata(a: FormIdentity, b: FormIdentity): boolean {
  if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
  const samePosition = a.formIndex !== undefined && b.formIndex !== undefined && a.formIndex === b.formIndex;
  if (a.formId && b.formId && a.formId !== b.formId && !samePosition) return false;
  if (a.formName && b.formName && a.formName !== b.formName && !samePosition) return false;
  return true;
}

export function sameForm(a: FormIdentity, b: FormIdentity): boolean {
  return a.fingerprint === b.fingerprint && sameFormMetadata(a, b);
}

function byRecentUse(a: SavedFilling, b: SavedFilling): number {
  return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt;
}

export function matchesForForm(entries: SavedFilling[], form: FormIdentity): SavedFilling[] {
  return entries.filter((entry) => sameForm(entry.form, form)).sort(byRecentUse);
}

function compatibleKind(saved: ControlKind, current: ControlKind): boolean {
  return saved === current || (textLikeKinds.has(saved) && textLikeKinds.has(current));
}

function normalized(value: string): string { return value.replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Expand legacy descriptors without consulting their old combined strings. */
export function fieldMatchKeys(descriptor: FieldDescriptor): FieldMatchKey[] {
  const values = new Map<FieldMatchStrategy, string | number>();
  for (const key of descriptor.matchKeys ?? []) {
    if (!strategyOrder.includes(key.strategy)) continue;
    if (key.strategy === 'position') {
      if (typeof key.value === 'number' && Number.isInteger(key.value) && key.value >= 0) values.set(key.strategy, key.value);
    } else if (typeof key.value === 'string' && key.value.trim()) values.set(key.strategy, key.value);
  }
  if (!values.has('id') && descriptor.id) values.set('id', descriptor.id);
  if (!values.has('name') && descriptor.name) values.set('name', descriptor.name);
  if (!values.has('label') && descriptor.label) values.set('label', descriptor.label);
  if (!values.has('position') && Number.isInteger(descriptor.index) && descriptor.index >= 0) values.set('position', descriptor.index);
  return strategyOrder.flatMap((strategy) => values.has(strategy) ? [{ strategy, value: values.get(strategy)! }] : []);
}

function optionCompatible(saved: FieldDescriptor, current: FieldDescriptor): boolean {
  if (saved.kind !== 'select-one' && saved.kind !== 'select-multiple') return true;
  return !saved.optionSignature || !current.optionSignature || saved.optionSignature === current.optionSignature;
}

function keyMatches(key: FieldMatchKey, descriptor: FieldDescriptor): boolean {
  if (key.strategy === 'id') return descriptor.id === key.value;
  if (key.strategy === 'name') return descriptor.name === key.value;
  if (key.strategy === 'label') return normalized(descriptor.label) === normalized(String(key.value));
  return descriptor.index === key.value;
}

function candidateSummary(field: CapturedField, fieldIndex: number): FieldCandidateSummary {
  const descriptor = field.descriptor;
  return { fieldIndex, kind: descriptor.kind, id: descriptor.id || '(none)', name: descriptor.name || '(none)', label: descriptor.label || '(none)', position: descriptor.index };
}

function fieldAttempts(saved: CapturedField, currentFields: CapturedField[]): { attempts: FieldKeyAttempt[]; candidateIndexes: number[] } {
  const attempts = fieldMatchKeys(saved.descriptor).map((key): FieldKeyAttempt => {
    const indexes = currentFields.flatMap((candidate, index) => compatibleKind(saved.descriptor.kind, candidate.descriptor.kind)
      && optionCompatible(saved.descriptor, candidate.descriptor)
      && keyMatches(key, candidate.descriptor) ? [index] : []);
    return {
      strategy: key.strategy,
      expected: key.value,
      compatibleMatches: indexes.length,
      candidates: indexes.map((index) => candidateSummary(currentFields[index], index)),
      unique: indexes.length === 1,
    };
  });
  const selected = attempts.find((attempt) => attempt.unique);
  return { attempts, candidateIndexes: selected ? [selected.candidates[0].fieldIndex] : [] };
}

/** A value-free field explanation used by unit tests and debug logging. */
export function explainFieldMatch(saved: CapturedField, currentFields: CapturedField[], savedFieldIndex = 0): FieldMatchTrace {
  const { attempts } = fieldAttempts(saved, currentFields);
  const selectedAttempt = attempts.find((attempt) => attempt.unique);
  return {
    savedFieldIndex,
    resultKey: saved.descriptor.key,
    included: saved.included,
    savedKind: saved.descriptor.kind,
    serializedKeys: fieldMatchKeys(saved.descriptor),
    matched: !saved.included || !!selectedAttempt,
    decision: !saved.included ? 'excluded' : selectedAttempt?.strategy ?? 'missing',
    selected: selectedAttempt?.candidates[0],
    attempts,
  };
}

/** Require a one-to-one mapping built only from independent key searches. */
function compatibleFieldStructure(saved: SavedFilling, current: FormSnapshot): boolean {
  const savedFields = saved.fields.filter((field) => field.included);
  if (!savedFields.length) return saved.fields.length === 0 && current.fields.length === 0;
  if (savedFields.length > current.fields.length) return false;
  const candidates = savedFields.map((field) => fieldAttempts(field, current.fields).candidateIndexes);
  if (candidates.some((indexes) => indexes.length === 0)) return false;

  const currentToSaved = new Map<number, number>();
  function assign(savedIndex: number, visited: Set<number>): boolean {
    for (const currentIndex of candidates[savedIndex]) {
      if (visited.has(currentIndex)) continue;
      visited.add(currentIndex);
      const previous = currentToSaved.get(currentIndex);
      if (previous === undefined || assign(previous, visited)) {
        currentToSaved.set(currentIndex, savedIndex);
        return true;
      }
    }
    return false;
  }
  return candidates.every((_, savedIndex) => assign(savedIndex, new Set()));
}

function comparison(valueA: string, valueB: string): 'match' | 'different' | 'unavailable' {
  if (!valueA || !valueB) return 'unavailable';
  return valueA === valueB ? 'match' : 'different';
}

/** A value-free explanation intended for opt-in diagnostic logging. */
export function explainSnapshotMatch(saved: SavedFilling, current: FormSnapshot): SnapshotMatchTrace {
  const samePosition = saved.form.formIndex !== undefined && current.form.formIndex !== undefined && saved.form.formIndex === current.form.formIndex;
  const metadataCompatible = sameFormMetadata(saved.form, current.form);
  const fingerprint = saved.form.fingerprint === current.form.fingerprint;
  const fields = saved.fields.map((field, index) => explainFieldMatch(field, current.fields, index));
  const structureCompatible = compatibleFieldStructure(saved, current);
  return {
    matched: metadataCompatible && structureCompatible,
    form: {
      origin: saved.form.origin === current.form.origin,
      pathname: saved.form.pathname === current.form.pathname,
      fingerprint,
      formId: comparison(saved.form.formId, current.form.formId),
      formName: comparison(saved.form.formName, current.form.formName),
      position: saved.form.formIndex === undefined || current.form.formIndex === undefined ? 'unavailable' : samePosition ? 'match' : 'different',
      metadataCompatible,
    },
    structure: { used: true, compatible: structureCompatible, savedFieldCount: saved.fields.filter((field) => field.included).length, currentFieldCount: current.fields.length, fields },
  };
}

export function matchesForSnapshot(entries: SavedFilling[], current: FormSnapshot): SavedFilling[] {
  return entries.filter((entry) => sameFormMetadata(entry.form, current.form) && compatibleFieldStructure(entry, current)).sort(byRecentUse);
}

export function suggestedName(form: FormIdentity, fields: number): string {
  const host = form.origin.replace(/^https?:\/\//, '');
  return `${host}${form.pathname === '/' ? '' : form.pathname} (${fields} fields)`;
}
