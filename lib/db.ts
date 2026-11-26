import Dexie, { type EntityTable } from "dexie";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_REDACTION_RULES,
  DEPRECATED_GEMINI_MODELS,
  normalizeGeminiModel,
  type AppSetting,
  type AppSettingsState,
  type ClinicalDocument,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyBackupPayload,
  type StudyVariable,
} from "./types";

class OncoDataExtractDB extends Dexie {
  studies!: EntityTable<Study, "id">;
  variables!: EntityTable<StudyVariable, "id">;
  patients!: EntityTable<Patient, "id">;
  documents!: EntityTable<ClinicalDocument, "id">;
  extractions!: EntityTable<ExtractionRecord, "id">;
  settings!: EntityTable<AppSetting, "key">;

  constructor() {
    super("OncoDataExtractDB");
    this.version(1).stores({
      studies: "id, createdAt, updatedAt",
      variables: "id, studyId, [studyId+order], [studyId+technicalName]",
      patients: "id, studyId, studyCode, validationStatus, extractionStatus",
      documents: "id, studyId, patientId, uploadedAt",
      extractions: "id, studyId, patientId, variableId, [patientId+variableId]",
      settings: "key",
    });
  }
}

export const db = new OncoDataExtractDB();

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeTechnicalName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function formatStudyCode(prefix: string, seq: number): string {
  const cleanPrefix = (prefix || "EST01").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${cleanPrefix}-${String(seq).padStart(3, "0")}`;
}

export async function createStudy(params: {
  name: string;
  description: string;
  codePrefix: string;
}): Promise<Study> {
  const now = new Date().toISOString();
  const study: Study = {
    id: generateId(),
    name: params.name.trim(),
    description: params.description.trim(),
    codePrefix:
      params.codePrefix
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8) || "EST01",
    nextPatientSeq: 1,
    redactionRules: { ...DEFAULT_REDACTION_RULES },
    createdAt: now,
    updatedAt: now,
  };
  await db.studies.add(study);
  return study;
}

export async function deleteStudyCascade(studyId: string): Promise<void> {
  await db.transaction(
    "rw",
    [db.studies, db.variables, db.patients, db.documents, db.extractions],
    async () => {
      await db.extractions.where("studyId").equals(studyId).delete();
      await db.documents.where("studyId").equals(studyId).delete();
      await db.patients.where("studyId").equals(studyId).delete();
      await db.variables.where("studyId").equals(studyId).delete();
      await db.studies.delete(studyId);
    }
  );
}

export async function deletePatientCascade(patientId: string): Promise<void> {
  await db.transaction(
    "rw",
    [db.patients, db.documents, db.extractions],
    async () => {
      await db.extractions.where("patientId").equals(patientId).delete();
      await db.documents.where("patientId").equals(patientId).delete();
      await db.patients.delete(patientId);
    }
  );
}

export async function deleteVariableCascade(variableId: string): Promise<void> {
  await db.transaction("rw", [db.variables, db.extractions], async () => {
    await db.extractions.where("variableId").equals(variableId).delete();
    await db.variables.delete(variableId);
  });
}

export async function allocateNextStudyCode(studyId: string): Promise<string> {
  return db.transaction("rw", db.studies, async () => {
    const study = await db.studies.get(studyId);
    if (!study) throw new Error("Estudio no encontrado");
    const seq = study.nextPatientSeq || 1;
    const code = formatStudyCode(study.codePrefix, seq);
    await db.studies.update(studyId, {
      nextPatientSeq: seq + 1,
      updatedAt: new Date().toISOString(),
    });
    return code;
  });
}

export async function getAppSettings(): Promise<AppSettingsState> {
  const rows = await db.settings.toArray();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const rawDefaultModel = (map.get("defaultModel") ?? "").trim();
  const rawCustomModel = (map.get("customModel") ?? "").trim();

  // Migración automática en IndexedDB si había modelos deprecados guardados (2.5 Flash/Pro)
  const migratedEntries: AppSetting[] = [];
  let defaultModel = normalizeGeminiModel(rawDefaultModel);
  if (rawDefaultModel && DEPRECATED_GEMINI_MODELS.has(rawDefaultModel)) {
    defaultModel = DEFAULT_GEMINI_MODEL;
    migratedEntries.push({ key: "defaultModel", value: DEFAULT_GEMINI_MODEL });
  }

  let customModel = rawCustomModel;
  if (rawCustomModel && DEPRECATED_GEMINI_MODELS.has(rawCustomModel)) {
    customModel = "";
    migratedEntries.push({ key: "customModel", value: "" });
  }

  if (migratedEntries.length > 0) {
    await db.settings.bulkPut(migratedEntries);
  }

  const delay = Number(map.get("rateLimitDelayMs") ?? "750");
  return {
    geminiApiKey: map.get("geminiApiKey") ?? "",
    defaultModel,
    customModel,
    rateLimitDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 750,
  };
}

export async function saveAppSettings(
  partial: Partial<AppSettingsState>
): Promise<void> {
  const entries: AppSetting[] = [];
  if (partial.geminiApiKey !== undefined) {
    entries.push({ key: "geminiApiKey", value: partial.geminiApiKey.trim() });
  }
  if (partial.defaultModel !== undefined) {
    entries.push({
      key: "defaultModel",
      value: normalizeGeminiModel(partial.defaultModel),
    });
  }
  if (partial.customModel !== undefined) {
    const trimmed = partial.customModel.trim();
    const cleaned =
      trimmed && DEPRECATED_GEMINI_MODELS.has(trimmed)
        ? DEFAULT_GEMINI_MODEL
        : trimmed;
    entries.push({ key: "customModel", value: cleaned });
  }
  if (partial.rateLimitDelayMs !== undefined) {
    entries.push({
      key: "rateLimitDelayMs",
      value: String(partial.rateLimitDelayMs),
    });
  }
  if (entries.length > 0) {
    await db.settings.bulkPut(entries);
  }
}

export async function exportStudyBackup(
  studyId: string
): Promise<StudyBackupPayload> {
  const study = await db.studies.get(studyId);
  if (!study) throw new Error("Estudio no encontrado para respaldo");
  const [variables, patients, documents, extractions] = await Promise.all([
    db.variables.where("studyId").equals(studyId).sortBy("order"),
    db.patients.where("studyId").equals(studyId).toArray(),
    db.documents.where("studyId").equals(studyId).toArray(),
    db.extractions.where("studyId").equals(studyId).toArray(),
  ]);
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    study,
    variables,
    patients,
    documents,
    extractions,
  };
}

export async function importStudyBackup(
  payload: StudyBackupPayload
): Promise<Study> {
  if (!payload || !payload.study || !Array.isArray(payload.variables)) {
    throw new Error("El archivo JSON no tiene un formato de respaldo válido.");
  }

  const now = new Date().toISOString();
  const newStudyId = generateId();
  const varIdMap = new Map<string, string>();
  const patIdMap = new Map<string, string>();
  const docIdMap = new Map<string, string>();

  const existingSameName = await db.studies
    .filter((s) => s.name === payload.study.name)
    .count();

  const newStudy: Study = {
    ...payload.study,
    id: newStudyId,
    name:
      existingSameName > 0
        ? `${payload.study.name} (Importado)`
        : payload.study.name,
    redactionRules: {
      ...DEFAULT_REDACTION_RULES,
      ...(payload.study.redactionRules ?? {}),
    },
    createdAt: now,
    updatedAt: now,
  };

  const newVariables: StudyVariable[] = payload.variables.map((v, idx) => {
    const id = generateId();
    varIdMap.set(v.id, id);
    return {
      ...v,
      id,
      studyId: newStudyId,
      order: v.order ?? idx,
    };
  });

  const newPatients: Patient[] = (payload.patients ?? []).map((p) => {
    const id = generateId();
    patIdMap.set(p.id, id);
    return {
      ...p,
      id,
      studyId: newStudyId,
    };
  });

  const newDocuments: ClinicalDocument[] = (payload.documents ?? [])
    .filter((d) => patIdMap.has(d.patientId))
    .map((d) => {
      const id = generateId();
      docIdMap.set(d.id, id);
      return {
        ...d,
        id,
        studyId: newStudyId,
        patientId: patIdMap.get(d.patientId)!,
      };
    });

  const newExtractions: ExtractionRecord[] = (payload.extractions ?? [])
    .filter((e) => patIdMap.has(e.patientId) && varIdMap.has(e.variableId))
    .map((e) => ({
      ...e,
      id: generateId(),
      studyId: newStudyId,
      patientId: patIdMap.get(e.patientId)!,
      variableId: varIdMap.get(e.variableId)!,
      sourceDocumentId: e.sourceDocumentId
        ? docIdMap.get(e.sourceDocumentId) ?? null
        : null,
    }));

  await db.transaction(
    "rw",
    [db.studies, db.variables, db.patients, db.documents, db.extractions],
    async () => {
      await db.studies.add(newStudy);
      if (newVariables.length) await db.variables.bulkAdd(newVariables);
      if (newPatients.length) await db.patients.bulkAdd(newPatients);
      if (newDocuments.length) await db.documents.bulkAdd(newDocuments);
      if (newExtractions.length) await db.extractions.bulkAdd(newExtractions);
    }
  );

  return newStudy;
}
