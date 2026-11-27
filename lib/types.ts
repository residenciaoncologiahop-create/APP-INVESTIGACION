export type VariableType =
  | "numeric"
  | "date"
  | "categorical_single"
  | "categorical_multiple"
  | "boolean"
  | "text";

export type VariableSection =
  | "demografia"
  | "enfermedad"
  | "tratamiento"
  | "desenlaces"
  | "custom";

export type ConfidenceLevel = "alta" | "media" | "baja";

export type ExtractionCellStatus = "extracted" | "missing" | "manual";

export type ValidationStatus = "pending" | "in_review" | "validated";

export type PatientExtractionStatus =
  | "idle"
  | "queued"
  | "processing"
  | "done"
  | "partial"
  | "error";

export type DocumentCategory =
  | "epicrisis"
  | "patologia"
  | "imagenes"
  | "evolucion"
  | "tratamiento"
  | "otro";

export type GeminiModel = string;

export interface DiscoveredGeminiModel {
  id: string;
  displayName: string;
  description?: string;
}

export type AiConnectionStatus =
  | "connected"
  | "configured_disconnected"
  | "not_configured";

export interface ModelsDiscoveryResponse {
  hasServerKey: boolean;
  hasManualKey: boolean;
  keySource: "manual" | "server" | "none";
  authenticated: boolean;
  connectionStatus: AiConnectionStatus;
  models: DiscoveredGeminiModel[];
  recommendedModel: string | null;
  fallbackModel: string | null;
  error?: string;
  technicalDetail?: string;
  checkedAt: string;
}

export interface RedactionRuleConfig {
  maskDni: boolean;
  maskNames: boolean;
  maskPhones: boolean;
  maskEmails: boolean;
  maskAddresses: boolean;
  maskRecordIds: boolean;
  customTerms: string[];
}

export interface Study {
  id: string;
  name: string;
  description: string;
  codePrefix: string;
  nextPatientSeq: number;
  redactionRules: RedactionRuleConfig;
  createdAt: string;
  updatedAt: string;
}

export interface StudyVariable {
  id: string;
  studyId: string;
  technicalName: string;
  label: string;
  section: VariableSection;
  type: VariableType;
  options: string[];
  aiInstruction: string;
  missingValue: string;
  unit?: string;
  order: number;
  createdAt: string;
}

export interface Patient {
  id: string;
  studyId: string;
  studyCode: string;
  originalIdentifier: string;
  validationStatus: ValidationStatus;
  extractionStatus: PatientExtractionStatus;
  extractionError?: string;
  extractionErrorDetail?: string;
  researcherNotes: string;
  lastExtractedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClinicalDocument {
  id: string;
  studyId: string;
  patientId: string;
  filename: string;
  fileType: "pdf" | "docx" | "txt" | "pasted";
  fileSize?: number;
  category: DocumentCategory;
  rawText: string;
  redactedText: string;
  redactionCount: number;
  redactionSummary: Record<string, number>;
  redactionConfirmed: boolean;
  isLowTextPdf?: boolean;
  extractedCharCount?: number;
  uploadedAt: string;
}

export type ExtractedValue = string | number | string[] | null;

export interface ExtractionRecord {
  id: string;
  studyId: string;
  patientId: string;
  variableId: string;
  value: ExtractedValue;
  status: ExtractionCellStatus;
  confidence: ConfidenceLevel | null;
  evidenceQuote: string | null;
  sourceDocumentId: string | null;
  sourceDocumentName: string | null;
  reasoning: string | null;
  manuallyEdited: boolean;
  modelUsed?: string;
  updatedAt: string;
}

export interface AppSetting {
  key: string;
  value: string;
}

export interface AppSettingsState {
  geminiApiKey: string;
  defaultModel: GeminiModel;
  fallbackModel: GeminiModel;
  customModel: string;
  rateLimitDelayMs: number;
  useDemoMode: boolean;
}

export interface VariableTemplateBlock {
  id: string;
  section: VariableSection;
  title: string;
  description: string;
  variables: Omit<StudyVariable, "id" | "studyId" | "order" | "createdAt">[];
}

export interface StudyBackupPayload {
  schemaVersion: 1;
  exportedAt: string;
  study: Study;
  variables: StudyVariable[];
  patients: Patient[];
  documents: ClinicalDocument[];
  extractions: ExtractionRecord[];
}

export interface CodebookExportPayload {
  schemaVersion: 1;
  studyName: string;
  exportedAt: string;
  variables: Omit<StudyVariable, "id" | "studyId" | "createdAt">[];
}

export interface GeminiVariableExtractionOutput {
  value: ExtractedValue;
  status: "extracted" | "missing";
  confidence: ConfidenceLevel;
  evidence_quote: string | null;
  source_document: string | null;
  reasoning: string | null;
}

export interface GeminiExtractionResponse {
  extractions: Record<string, GeminiVariableExtractionOutput>;
  mode: "gemini" | "mock";
  modelUsed: string;
  warning?: string;
  modelAutoUpdated?: boolean;
  resolvedModel?: string;
  fallbackUsed?: boolean;
  omittedVariables?: string[];
}

export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  numeric: "Numérico",
  date: "Fecha (DD/MM/AAAA)",
  categorical_single: "Categórico Único",
  categorical_multiple: "Categórico Múltiple",
  boolean: "Booleano (Sí/No/Desconocido)",
  text: "Texto libre breve",
};

export const VARIABLE_SECTION_LABELS: Record<VariableSection, string> = {
  demografia: "Demografía y Estado Funcional",
  enfermedad: "Enfermedad y Biología",
  tratamiento: "Tratamiento",
  desenlaces: "Desenlaces / Supervivencia",
  custom: "Otras Variables",
};

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  epicrisis: "Epicrisis",
  patologia: "Anatomía Patológica",
  imagenes: "Imágenes (TAC/PET/RMN)",
  evolucion: "Evolución Clínica",
  tratamiento: "Protocolo de Tratamiento",
  otro: "Otro Documento",
};

export const VALIDATION_STATUS_LABELS: Record<ValidationStatus, string> = {
  pending: "Pendiente de revisión",
  in_review: "En revisión",
  validated: "Validado",
};

export const DEFAULT_REDACTION_RULES: RedactionRuleConfig = {
  maskDni: true,
  maskNames: true,
  maskPhones: true,
  maskEmails: true,
  maskAddresses: true,
  maskRecordIds: true,
  customTerms: [],
};
