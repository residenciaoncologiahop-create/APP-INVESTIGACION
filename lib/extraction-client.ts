import { db, generateId, getAppSettings } from "./db";
import {
  normalizeGeminiModel,
  type ClinicalDocument,
  type ExtractionRecord,
  type GeminiExtractionResponse,
  type GeminiModel,
  type Patient,
  type Study,
  type StudyVariable,
} from "./types";

export interface BatchQueueProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  currentPatientCode: string | null;
  lastMode: "gemini" | "mock" | null;
  lastWarning: string | null;
  retryMessage: string | null;
}

export interface BatchExtractionOptions {
  study: Study;
  patients: Patient[];
  variables: StudyVariable[];
  modelOverride?: GeminiModel;
  missingVariablesOnly?: boolean;
  forceMock?: boolean;
  shouldPause: () => boolean;
  shouldAbort: () => boolean;
  onProgress: (progress: BatchQueueProgress) => void;
}

const RETRY_BASE_DELAYS_MS = [5000, 12000, 25000, 45000, 60000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithCountdown(
  totalMs: number,
  shouldAbort: () => boolean,
  onTick: (remainingSeconds: number) => void
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  let lastReportedSec = -1;

  while (true) {
    if (shouldAbort()) return false;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return true;

    const remainingSec = Math.ceil(remainingMs / 1000);
    if (remainingSec !== lastReportedSec) {
      lastReportedSec = remainingSec;
      onTick(remainingSec);
    }
    await sleep(Math.min(250, remainingMs));
  }
}

function findSourceDocumentId(
  docs: ClinicalDocument[],
  sourceDocName: string | null,
  evidenceQuote: string | null
): { id: string | null; name: string | null } {
  if (sourceDocName) {
    const exact = docs.find(
      (d) => d.filename.toLowerCase() === sourceDocName.trim().toLowerCase()
    );
    if (exact) return { id: exact.id, name: exact.filename };
  }
  if (evidenceQuote) {
    const normQuote = evidenceQuote.trim().toLowerCase();
    const byQuote = docs.find(
      (d) =>
        d.redactedText.toLowerCase().includes(normQuote) ||
        d.rawText.toLowerCase().includes(normQuote)
    );
    if (byQuote) return { id: byQuote.id, name: byQuote.filename };
  }
  if (docs.length === 1) {
    return { id: docs[0].id, name: docs[0].filename };
  }
  return { id: null, name: sourceDocName };
}

async function callExtractApiWithBackoff(
  payload: Record<string, unknown>,
  shouldAbort: () => boolean,
  onRetry: (msg: string) => void
): Promise<GeminiExtractionResponse> {
  const maxRetries = RETRY_BASE_DELAYS_MS.length; // 5 reintentos (6 intentos en total)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (shouldAbort()) {
      throw new Error("ABORTED_BY_USER");
    }

    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      return data as GeminiExtractionResponse;
    }

    const isRateOrDemandError =
      res.status === 429 ||
      res.status === 503 ||
      /503|429|UNAVAILABLE|high\s*demand|RESOURCE_EXHAUSTED/i.test(String(data?.error ?? ""));
    const retryable = isRateOrDemandError || res.status >= 500 || Boolean(data?.retryable);

    if (retryable && attempt < maxRetries) {
      const baseDelay = RETRY_BASE_DELAYS_MS[attempt];
      const jitterMs = Math.round(Math.random() * 1500);
      const totalDelayMs = baseDelay + jitterMs;
      const reasonLabel =
        res.status === 503
          ? "Error 503 UNAVAILABLE (alta demanda en Gemini)"
          : res.status === 429
            ? "Límite de tasa 429 en Gemini"
            : `Error temporal HTTP ${res.status}`;

      const completedWait = await waitWithCountdown(
        totalDelayMs,
        shouldAbort,
        (remainingSec) => {
          onRetry(
            `${reasonLabel}. Reintento ${attempt + 1}/${maxRetries} en ${remainingSec}s...`
          );
        }
      );

      if (!completedWait) {
        throw new Error("ABORTED_BY_USER");
      }
      onRetry(`Reintentando (${attempt + 1}/${maxRetries})...`);
      continue;
    }

    throw new Error(data?.error || `Error HTTP ${res.status} en extracción IA.`);
  }
  throw new Error("Se agotaron los 5 reintentos de extracción.");
}

export async function runBatchExtraction(
  options: BatchExtractionOptions
): Promise<BatchQueueProgress> {
  const settings = await getAppSettings();
  const configuredModel = settings.customModel.trim() || settings.defaultModel;
  const model = normalizeGeminiModel(options.modelOverride ?? configuredModel);

  const progress: BatchQueueProgress = {
    total: options.patients.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    currentPatientCode: null,
    lastMode: null,
    lastWarning: null,
    retryMessage: null,
  };

  options.onProgress({ ...progress });

  // Marcar cola inicial
  for (const patient of options.patients) {
    await db.patients.update(patient.id, {
      extractionStatus: "queued",
      extractionError: undefined,
    });
  }

  for (const patient of options.patients) {
    if (options.shouldAbort()) break;

    while (options.shouldPause()) {
      if (options.shouldAbort()) break;
      await sleep(250);
    }
    if (options.shouldAbort()) break;

    progress.currentPatientCode = patient.studyCode;
    progress.retryMessage = null;
    options.onProgress({ ...progress });

    try {
      const docs = await db.documents
        .where("patientId")
        .equals(patient.id)
        .toArray();

      if (docs.length === 0) {
        progress.skipped += 1;
        progress.completed += 1;
        await db.patients.update(patient.id, {
          extractionStatus: "error",
          extractionError: "Sin documentos clínicos asociados.",
        });
        options.onProgress({ ...progress });
        continue;
      }

      // Determinar qué variables extraer (todas o solo las nuevas sin registro)
      let targetVariables = options.variables;
      if (options.missingVariablesOnly) {
        const existing = await db.extractions
          .where("patientId")
          .equals(patient.id)
          .toArray();
        const existingVarIds = new Set(existing.map((e) => e.variableId));
        targetVariables = options.variables.filter((v) => !existingVarIds.has(v.id));

        if (targetVariables.length === 0) {
          progress.skipped += 1;
          progress.completed += 1;
          await db.patients.update(patient.id, {
            extractionStatus: "done",
          });
          options.onProgress({ ...progress });
          continue;
        }
      }

      await db.patients.update(patient.id, {
        extractionStatus: "processing",
        extractionError: undefined,
      });

      const apiResponse = await callExtractApiWithBackoff(
        {
          studyName: options.study.name,
          model,
          apiKey: settings.geminiApiKey,
          forceMock: options.forceMock,
          variables: targetVariables,
          documents: docs.map((d) => ({
            id: d.id,
            filename: d.filename,
            category: d.category,
            text: d.redactedText || d.rawText,
          })),
        },
        options.shouldAbort,
        (retryMsg) => {
          progress.retryMessage = retryMsg;
          options.onProgress({ ...progress });
        }
      );

      progress.lastMode = apiResponse.mode;
      if (apiResponse.warning) {
        progress.lastWarning = apiResponse.warning;
      }

      const now = new Date().toISOString();
      const existingAll = await db.extractions
        .where("patientId")
        .equals(patient.id)
        .toArray();
      const existingByVar = new Map(existingAll.map((e) => [e.variableId, e]));

      const recordsToPut: ExtractionRecord[] = [];
      for (const variable of targetVariables) {
        const out = apiResponse.extractions[variable.technicalName];
        const prev = existingByVar.get(variable.id);

        // Si ya fue editado manualmente por el investigador y estamos en modo incremental, preservarlo
        if (options.missingVariablesOnly && prev?.manuallyEdited) {
          continue;
        }

        const source = findSourceDocumentId(
          docs,
          out?.source_document ?? null,
          out?.evidence_quote ?? null
        );

        recordsToPut.push({
          id: prev?.id ?? generateId(),
          studyId: options.study.id,
          patientId: patient.id,
          variableId: variable.id,
          value: out ? out.value : null,
          status: out?.status === "extracted" && out.value !== null ? "extracted" : "missing",
          confidence: out?.confidence ?? "baja",
          evidenceQuote: out?.evidence_quote ?? null,
          sourceDocumentId: source.id,
          sourceDocumentName: source.name,
          reasoning: out?.reasoning ?? null,
          manuallyEdited: false,
          modelUsed: apiResponse.modelUsed,
          updatedAt: now,
        });
      }

      await db.transaction("rw", [db.extractions, db.patients], async () => {
        if (recordsToPut.length > 0) {
          await db.extractions.bulkPut(recordsToPut);
        }
        await db.patients.update(patient.id, {
          extractionStatus: "done",
          extractionError: undefined,
          lastExtractedAt: now,
          updatedAt: now,
        });
      });

      progress.succeeded += 1;
      progress.completed += 1;
      progress.retryMessage = null;
      options.onProgress({ ...progress });

      // Pausa suave entre pacientes para cuidar cuota RPM
      if (settings.rateLimitDelayMs > 0 && progress.completed < progress.total) {
        await sleep(settings.rateLimitDelayMs);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "ABORTED_BY_USER") {
        await db.patients.update(patient.id, {
          extractionStatus: patient.lastExtractedAt ? "done" : "idle",
          updatedAt: new Date().toISOString(),
        });
        progress.retryMessage = null;
        options.onProgress({ ...progress });
        break;
      }
      const msg = err instanceof Error ? err.message : "Error desconocido en extracción";
      await db.patients.update(patient.id, {
        extractionStatus: "error",
        extractionError: msg,
        updatedAt: new Date().toISOString(),
      });
      progress.failed += 1;
      progress.completed += 1;
      progress.retryMessage = null;
      options.onProgress({ ...progress });
    }
  }

  progress.currentPatientCode = null;
  options.onProgress({ ...progress });
  return progress;
}
