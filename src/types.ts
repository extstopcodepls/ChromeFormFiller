export type ControlKind =
  | 'text' | 'search' | 'email' | 'url' | 'tel' | 'textarea' | 'number'
  | 'checkbox' | 'radio' | 'select-one' | 'select-multiple' | 'range'
  | 'date' | 'time' | 'month' | 'week' | 'datetime-local' | 'color' | 'file';

export type FieldValue =
  | { tag: 'text'; value: string }
  | { tag: 'boolean'; value: boolean }
  | { tag: 'radio'; value: string | null }
  | { tag: 'options'; values: string[] }
  | { tag: 'file'; files: FileReference[] };

export type FieldMatchStrategy = 'id' | 'name' | 'label' | 'position';

/** A single independently searchable element attribute. */
export interface FieldMatchKey {
  strategy: FieldMatchStrategy;
  value: string | number;
}

export interface FileReference {
  path?: string;
  name: string;
  size?: number;
  lastModified?: number;
}

export interface FieldDescriptor {
  /** Result identifier only. It is never used to locate or match an element. */
  key: string;
  kind: ControlKind;
  name: string;
  id: string;
  label: string;
  index: number;
  /** Independently serialized lookup keys. Optional for legacy records. */
  matchKeys?: FieldMatchKey[];
  /** @deprecated Legacy records may contain this combined signature. */
  typeSignature?: string;
  optionSignature?: string;
  autocomplete?: string;
  formId?: string;
  formName?: string;
  constraints?: { min?: string; max?: string; step?: string; pattern?: string };
}

export interface CapturedField {
  descriptor: FieldDescriptor;
  value: FieldValue;
  included: boolean;
  unavailableReason?: string;
}

export interface FormIdentity {
  origin: string;
  pathname: string;
  formId: string;
  formName: string;
  actionOrigin: string;
  actionPath: string;
  method: string;
  fingerprint: string;
  /** Position among top-level document forms; used only to disambiguate identical forms. */
  formIndex?: number;
}

export interface FormSnapshot {
  form: FormIdentity;
  fields: CapturedField[];
  capturedAt: number;
  revision: number;
  completeness: 'complete' | 'partial' | 'oversized';
}

export interface SavedFilling {
  id: string;
  schemaVersion: 1;
  name: string;
  form: FormIdentity;
  fields: CapturedField[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface PendingDraft extends FormSnapshot {
  id: string;
  sourceTabId?: number;
  sourceDocumentId?: string;
  submissionObserved: boolean;
  basedOnEarlierSnapshot?: boolean;
  expiresAt: number;
}

export interface FillFieldResult {
  key: string;
  status: 'filled' | 'unchanged' | 'manual' | 'missing' | 'failed' | 'canceled';
  message?: string;
}

export interface FillResult {
  status: 'completed' | 'partial' | 'canceled' | 'failed';
  fields: FillFieldResult[];
  message?: string;
}

export interface SiteStatus {
  origin: string;
  enabled: boolean;
  permission: boolean;
  unlocked: boolean;
  pendingCount: number;
  debug: boolean;
}

export interface MatchSummary {
  id: string;
  name: string;
  lastUsedAt?: number;
  updatedAt: number;
  fieldCount: number;
  preview: Array<{ key: string; label: string; kind: ControlKind; id: string; name: string; index: number; matchKeys: FieldMatchKey[]; value: string }>;
}
