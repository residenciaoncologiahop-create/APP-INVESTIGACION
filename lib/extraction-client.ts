import { classifyAndFormatAiError } from "./ai-errors";
import { db, generateId, getAppSettings, saveAppSettings } from "./db";
import {
  isDocumentLowTextPdf,
  MIN_SELECTABLE_TEXT_LENGTH,
  SCANNED_PDF_WARNING,
} from "./document-parser";
import {
  formatNeutralDocumentId,
  getMissingMinimumRedactionRules,
  hasUsableRedactedText,
  isRedactionEnabled,
  MINIMUM_REDACTION_RULE_LABELS,
} from "./redactor";
import type {
  AppSettingsState,
  ClinicalDocument,
  ExtractionRecord,
  GeminiExtractionResponse,
  GeminiModel,
  ModelsDiscoveryResponse,
  Patient,
  Study,
  StudyVariable,
} from "./types";

export interface BatchQueueProgress {
  total: number;
  completed: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  currentPatientCode: string | null;
  activeModel: string | null;
  lastMode: "gemini" | "mock" | null;
  lastWarning: string | null;
  retryMessage: string | null;
}

export interface BatchExtractionStorageAdapter {
  getSettings: () => Promise<AppSettingsState>;
  saveSettings: (partial: Partial<AppSettingsState>) => Promise<void>;
  getPatientDocuments: (patientId: string) => Promise<ClinicalDocument[]>;
  getPatientExtractions: (patientId: string) => Promise<ExtractionRecord[]>;
  updatePatient: (patientId: string, patch: Partial<Patient>) => Promise<void>;
  savePatientExtractionResult: (params: {
    patientId: string;
    records: ExtractionRecord[];
    patientPatch: Partial<Patient>;
  }) => Promise<void>;
}

export interface BatchExtractionOptions {
  study: Study;
  patients: Patient[];
  variables: StudyVariable[];
  modelOverride?: GeminiModel;
  fallbackModelOverride?: GeminiModel;
  missingVariablesOnly?: boolean;
  forceReextract?: boolean;
  forceMock?: boolean;
  shouldPause: () => boolean;
  shouldAbort: () => boolean;
  onProgress: (progress: BatchQueueProgress) => void;
  /** Inyecciones opcionales para pruebas automatizadas */
  fetchFn?: typeof fetch;
  storage?: BatchExtractionStorageAdapter;
  retryDelaysMs?: readonly number[];
  sleepFn?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [5000, 12000] as const;

export class ExtractionApiError extends Error {
  userMessage: string;
  status: number;
  code: string;
  technicalDetail: string;
  retryable: boolean;
  modelAutoUpdated?: boolean;
  resolvedModel?: string;
  suggestedFallbackModel?: string;

  constructor(params: {
    userMessage: string;
    technicalDetail: string;
    status: number;
    code: string;
    retryable: boolean;
    modelAutoUpdated?: boolean;
    resolvedModel?: string;
    suggestedFallbackModel?: string;
  }) {
    super(params.userMessage);
    this.name = "ExtractionApiError";
    this.userMessage = params.userMessage;
    this.status = params.status;
    this.code = params.code;
    this.technicalDetail = params.technicalDetail;
    this.retryable = params.retryable;
    this.modelAutoUpdated = params.modelAutoUpdated;
    this.resolvedModel = params.resolvedModel;
    this.suggestedFallbackModel = params.suggestedFallbackModel;
  }
}

const defaultStorageAdapter: BatchExtractionStorageAdapter = {
  getSettings: getAppSettings,
  saveSettings: saveAppSettings,
  getPatientDocuments: (patientId) =>
    db.documents.where("patientId").equals(patientId).toArray(),
  getPatientExtractions: (patientId) =>
    db.extractions.where("patientId").equals(patientId).toArray(),
  updatePatient: async (patientId, patch) => {
    await db.patients.update(patientId, patch);
  },
  savePatientExtractionResult: async ({ patientId, records, patientPatch }) => {
    await db.transaction("rw", [db.extractions, db.patients], async () => {
      if (records.length > 0) {
        await db.extractions.bulkPut(records);
      }
      if (Object.keys(patientPatch).length > 0) {
        await db.patients.update(patientId, patientPatch);
      }
    });
  },
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithCountdown(
  totalMs: number,
  shouldAbort: () => boolean,
  onTick: (remainingSeconds: number) => void,
  sleepFn: (ms: number) => Promise<void>
): Promise<boolean> {
  if (totalMs <= 0) return !shouldAbort();

  // En pruebas rápidas (< 100ms), esperar directamente sin bucle de ticks
  if (totalMs < 100) {
    if (shouldAbort()) return false;
    await sleepFn(totalMs);
    return !shouldAbort();
  }

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
    await sleepFn(Math.min(250, remainingMs));
  }
}

function findSourceDocumentId(
  docs: ClinicalDocument[],
  sourceDocName: string | null,
  evidenceQuote: string | null,
  aliasToDoc?: Map<string, ClinicalDocument>
): { id: string | null; name: string | null } {
  if (sourceDocName && aliasToDoc && aliasToDoc.size > 0) {
    const trimmedUpper = sourceDocName.trim().toUpperCase();
    const byExactAlias = aliasToDoc.get(trimmedUpper);
    if (byExactAlias) {
      return { id: byExactAlias.id, name: byExactAlias.filename };
    }
    const embeddedAlias = trimmedUpper.match(/\b(DOC-\d{2,})\b/);
    if (embeddedAlias) {
      const byEmbedded = aliasToDoc.get(embeddedAlias[1]);
      if (byEmbedded) {
        return { id: byEmbedded.id, name: byEmbedded.filename };
      }
    }
  }
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
        (d.redactedText || "").toLowerCase().includes(normQuote) ||
        (d.rawText || "").toLowerCase().includes(normQuote)
    );
    if (byQuote) return { id: byQuote.id, name: byQuote.filename };
  }
  if (docs.length === 1) {
    return { id: docs[0].id, name: docs[0].filename };
  }
  return { id: null, name: sourceDocName };
}

export async function fetchAvailableModels(
  manualApiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<ModelsDiscoveryResponse> {
  const headers: Record<string, string> = {};
  if (manualApiKey.trim()) {
    headers["x-gemini-api-key"] = manualApiKey.trim();
  }

  let res: Response;
  try {
    res = await fetchFn("/api/models", {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch (err) {
    const formatted = classifyAndFormatAiError(err);
    return {
      hasServerKey: false,
      hasManualKey: Boolean(manualApiKey.trim()),
      keySource: manualApiKey.trim() ? "manual" : "none",
      authenticated: false,
      connectionStatus: "configured_disconnected",
      models: [],
      recommendedModel: null,
      fallbackModel: null,
      error: formatted.userMessage,
      technicalDetail: formatted.technicalDetail,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    return (await res.json()) as ModelsDiscoveryResponse;
  } catch (err) {
    const formatted = classifyAndFormatAiError(err, { status: res.status });
    return {
      hasServerKey: false,
      hasManualKey: Boolean(manualApiKey.trim()),
      keySource: manualApiKey.trim() ? "manual" : "none",
      authenticated: false,
      connectionStatus: "configured_disconnected",
      models: [],
      recommendedModel: null,
      fallbackModel: null,
      error: formatted.userMessage,
      technicalDetail: formatted.technicalDetail,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function postExtractOnce(
  payload: Record<string, unknown>,
  fetchFn: typeof fetch
): Promise<GeminiExtractionResponse> {
  let res: Response;
  try {
    res = await fetchFn("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const formatted = classifyAndFormatAiError(err);
    throw new ExtractionApiError({
      userMessage: formatted.userMessage,
      technicalDetail: formatted.technicalDetail,
      status: formatted.status,
      code: formatted.code,
      retryable: formatted.retryable,
    });
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (!res.ok) {
      const formatted = classifyAndFormatAiError(err, { status: res.status });
      throw new ExtractionApiError({
        userMessage: formatted.userMessage,
        technicalDetail: formatted.technicalDetail,
        status: res.status,
        code: formatted.code,
        retryable: res.status >= 500,
      });
    }
  }

  if (res.ok) {
    return data as unknown as GeminiExtractionResponse;
  }

  const rawErrText = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
  const formatted = classifyAndFormatAiError(rawErrText, { status: res.status });
  const explicitDetail =
    typeof data.technicalDetail === "string" && data.technicalDetail.trim()
      ? data.technicalDetail.trim()
      : formatted.technicalDetail;
  const code = typeof data.code === "string" ? data.code : formatted.code;
  const retryable =
    typeof data.retryable === "boolean" ? data.retryable : formatted.retryable;

  // Si el backend ya devolvió un mensaje humano claro (no JSON crudo), conservarlo
  const looksRaw = /^\s*\{|"error"\s*:|UNAVAILABLE|RESOURCE_EXHAUSTED|API_KEY_INVALID|NOT_FOUND/i.test(
    rawErrText
  );

  throw new ExtractionApiError({
    userMessage: looksRaw ? formatted.userMessage : rawErrText,
    technicalDetail: explicitDetail,
    status: res.status,
    code,
    retryable,
    modelAutoUpdated: data.modelAutoUpdated === true,
    resolvedModel:
      typeof data.resolvedModel === "string" && data.resolvedModel.trim()
        ? data.resolvedModel.trim()
        : undefined,
    suggestedFallbackModel:
      typeof data.suggestedFallbackModel === "string" && data.suggestedFallbackModel.trim()
        ? data.suggestedFallbackModel.trim()
        : undefined,
  });
}

function isDemandOrRateLimitError(err: ExtractionApiError): boolean {
  return (
    err.status === 429 ||
    err.status === 503 ||
    err.code === "rate_limit" ||
    err.code === "overloaded"
  );
}

interface CallWithFallbackResult {
  response: GeminiExtractionResponse;
  updatedPrimaryModel?: string;
  updatedFallbackModel?: string | null;
  usedFallback?: boolean;
  notice?: string;
}

async function callExtractWithRetriesAndFallback(params: {
  basePayload: Record<string, unknown>;
  primaryModel: string;
  fallbackModel: string | null;
  manualApiKey: string;
  forceMock: boolean;
  shouldAbort: () => boolean;
  onRetry: (msg: string) => void;
  fetchFn: typeof fetch;
  retryDelaysMs: readonly number[];
  sleepFn: (ms: number) => Promise<void>;
}): Promise<CallWithFallbackResult> {
  const {
    basePayload,
    manualApiKey,
    forceMock,
    shouldAbort,
    onRetry,
    fetchFn,
    retryDelaysMs,
    sleepFn,
  } = params;

  if (forceMock) {
    const response = await postExtractOnce({ ...basePayload, forceMock: true }, fetchFn);
    return { response };
  }

  let currentPrimary = params.primaryModel;
  let currentFallback = params.fallbackModel;
  let modelWasAutoUpdated = false;
  let autoUpdateNotice: string | undefined;

  const runModelWithRetries = async (
    initialModelId: string,
    allowRetries: boolean
  ): Promise<GeminiExtractionResponse> => {
    const maxRetries = allowRetries ? retryDelaysMs.length : 0;
    let activeModelId = initialModelId;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (shouldAbort()) {
        throw new Error("ABORTED_BY_USER");
      }

      try {
        const res = await postExtractOnce({ ...basePayload, model: activeModelId }, fetchFn);
        if (res.modelAutoUpdated && res.resolvedModel) {
          currentPrimary = res.resolvedModel;
          modelWasAutoUpdated = true;
          autoUpdateNotice =
            res.warning ||
            "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.";
        }
        return res;
      } catch (err) {
        if (!(err instanceof ExtractionApiError)) throw err;

        // Si el servidor ya resolvió un reemplazo tras 404 y ese reemplazo dio 429/503,
        // adoptar inmediatamente el modelo resuelto para no volver a enviar el modelo obsoleto.
        if (err.resolvedModel && err.resolvedModel !== activeModelId) {
          activeModelId = err.resolvedModel;
          currentPrimary = err.resolvedModel;
          modelWasAutoUpdated = true;
          autoUpdateNotice =
            "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.";
          if (err.suggestedFallbackModel && err.suggestedFallbackModel !== currentPrimary) {
            currentFallback = err.suggestedFallbackModel;
          } else if (currentFallback === currentPrimary) {
            currentFallback = null;
          }
        }

        if (isDemandOrRateLimitError(err) && attempt < maxRetries) {
          const waitMs = retryDelaysMs[attempt];
          const reasonLabel =
            err.status === 503 || err.code === "overloaded"
              ? "El servicio de IA está temporalmente ocupado"
              : "Se alcanzó temporalmente el límite de consultas";

          const completedWait = await waitWithCountdown(
            waitMs,
            shouldAbort,
            (remainingSec) => {
              onRetry(
                `${reasonLabel}. Reintentando automáticamente (${attempt + 1}/${maxRetries}) en ${remainingSec}s...`
              );
            },
            sleepFn
          );

          if (!completedWait) {
            throw new Error("ABORTED_BY_USER");
          }
          onRetry(`Reintentando análisis (${attempt + 1}/${maxRetries})...`);
          continue;
        }

        throw err;
      }
    }

    throw new ExtractionApiError({
      userMessage:
        "El servicio de IA está temporalmente ocupado. Intentá nuevamente en unos minutos o probá otro modelo.",
      technicalDetail: `Se agotaron los reintentos con el modelo ${activeModelId}.`,
      status: 503,
      code: "overloaded",
      retryable: true,
    });
  };

  try {
    const response = await runModelWithRetries(currentPrimary, true);
    if (modelWasAutoUpdated) {
      return {
        response,
        updatedPrimaryModel: currentPrimary,
        updatedFallbackModel: currentFallback,
        notice:
          autoUpdateNotice ||
          response.warning ||
          "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.",
      };
    }
    return { response };
  } catch (err) {
    if (err instanceof Error && err.message === "ABORTED_BY_USER") {
      throw err;
    }

    if (!(err instanceof ExtractionApiError)) {
      throw err;
    }

    let apiErr: ExtractionApiError = err;

    // 1. Ante error 404 (modelo inexistente): redescubrir modelos, actualizar y reintentar
    if (apiErr.status === 404 || apiErr.code === "not_found") {
      onRetry("El modelo seleccionado ya no está disponible. Buscando uno compatible...");
      const refreshed = await fetchAvailableModels(manualApiKey, fetchFn);
      if (refreshed.authenticated && refreshed.recommendedModel) {
        currentPrimary = refreshed.recommendedModel;
        currentFallback =
          refreshed.fallbackModel && refreshed.fallbackModel !== currentPrimary
            ? refreshed.fallbackModel
            : null;
        modelWasAutoUpdated = true;
        autoUpdateNotice =
          "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.";

        try {
          const response = await runModelWithRetries(currentPrimary, true);
          return {
            response,
            updatedPrimaryModel: currentPrimary,
            updatedFallbackModel: currentFallback,
            notice: autoUpdateNotice,
          };
        } catch (afterRefreshErr) {
          if (
            afterRefreshErr instanceof ExtractionApiError &&
            isDemandOrRateLimitError(afterRefreshErr) &&
            currentFallback &&
            currentFallback !== currentPrimary
          ) {
            // Caer al bloque de modelo alternativo más abajo
            apiErr = afterRefreshErr;
          } else {
            throw afterRefreshErr;
          }
        }
      } else {
        throw new ExtractionApiError({
          userMessage:
            refreshed.error ||
            "El modelo seleccionado ya no está disponible y no se pudo obtener un modelo alternativo.",
          technicalDetail: refreshed.technicalDetail || apiErr.technicalDetail,
          status: 404,
          code: "not_found",
          retryable: false,
        });
      }
    }

    // 2. Si tras 2 reintentos (5s y 12s) persiste 429 o 503, intentar el modelo alternativo
    if (isDemandOrRateLimitError(apiErr) && currentFallback && currentFallback !== currentPrimary) {
      onRetry(
        `El modelo principal sigue ocupado. Probando automáticamente el modelo alternativo (${currentFallback})...`
      );
      try {
        const fallbackResponse = await runModelWithRetries(currentFallback, false);
        return {
          response: {
            ...fallbackResponse,
            fallbackUsed: true,
          },
          ...(modelWasAutoUpdated
            ? {
                updatedPrimaryModel: currentPrimary,
                updatedFallbackModel: currentFallback,
              }
            : {}),
          usedFallback: true,
          notice:
            autoUpdateNotice ||
            `El modelo principal estuvo ocupado; se completó el análisis usando el modelo alternativo (${currentFallback}).`,
        };
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error && fallbackErr.message === "ABORTED_BY_USER") {
          throw fallbackErr;
        }
        const fbDetail =
          fallbackErr instanceof ExtractionApiError
            ? fallbackErr.technicalDetail
            : fallbackErr instanceof Error
              ? fallbackErr.message
              : "Error en modelo alternativo";

        throw new ExtractionApiError({
          userMessage:
            "No se pudo completar la extracción: tanto el modelo principal como el modelo alternativo no respondieron. Intentá nuevamente en unos minutos.",
          technicalDetail: `Principal (${currentPrimary}): ${apiErr.technicalDetail} | Alternativo (${currentFallback}): ${fbDetail}`,
          status:
            fallbackErr instanceof ExtractionApiError ? fallbackErr.status : apiErr.status,
          code: fallbackErr instanceof ExtractionApiError ? fallbackErr.code : apiErr.code,
          retryable: true,
        });
      }
    }

    throw apiErr;
  }
}

export async function runBatchExtraction(
  options: BatchExtractionOptions
): Promise<BatchQueueProgress> {
  const storage = options.storage ?? defaultStorageAdapter;
  const fetchFn = options.fetchFn ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleepFn = options.sleepFn ?? defaultSleep;

  const settings = await storage.getSettings();
  const useDemo = Boolean(options.forceMock || settings.useDemoMode);

  const progress: BatchQueueProgress = {
    total: options.patients.length,
    completed: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    currentPatientCode: null,
    activeModel: useDemo ? "modo-demostracion-local" : null,
    lastMode: null,
    lastWarning: null,
    retryMessage: null,
  };

  let activePrimaryModel = "";
  let activeFallbackModel: string | null = null;
  let effectiveForceMock = useDemo;

  if (!isRedactionEnabled(options.study.redactionRules)) {
    const missingRules = getMissingMinimumRedactionRules(
      options.study.redactionRules
    );
    const missingLabels = missingRules
      .map((key) => MINIMUM_REDACTION_RULE_LABELS[key])
      .join(", ");
    const errMsg = `Extracción bloqueada: activá las reglas mínimas de protección de datos (${missingLabels}) y revisá la redacción antes de analizar.`;
    const now = new Date().toISOString();

    for (const patient of options.patients) {
      if (patient.validationStatus === "validated") {
        progress.skipped += 1;
        progress.completed += 1;
        continue;
      }
      await storage.updatePatient(patient.id, {
        extractionStatus: "error",
        extractionError: errMsg,
        extractionErrorDetail: `Reglas mínimas faltantes: ${missingLabels}. Este filtro automático no reemplaza la revisión manual de datos identificatorios.`,
        updatedAt: now,
      });
      progress.failed += 1;
      progress.completed += 1;
    }
    progress.lastWarning = errMsg;
    options.onProgress({ ...progress });
    return progress;
  }

  if (!effectiveForceMock) {
    const discovery = await fetchAvailableModels(settings.geminiApiKey, fetchFn);

    if (discovery.connectionStatus === "not_configured") {
      // Sin clave configurada: no ocultar que no hay IA conectada, usar modo demo explícito
      effectiveForceMock = true;
      progress.activeModel = "modo-demostracion-local";
      progress.lastWarning =
        "No hay una clave de IA configurada. Se ejecutó el modo de demostración local.";
    } else if (!discovery.authenticated || !discovery.recommendedModel) {
      // Hay clave configurada pero falló autenticación o conectividad: NO simular éxito
      const errMsg =
        discovery.error ||
        "La IA está configurada pero no se pudo conectar. Revisá la configuración.";
      const errDetail =
        discovery.technicalDetail || "Fallo en la verificación inicial de /api/models.";
      const now = new Date().toISOString();

      for (const patient of options.patients) {
        if (patient.validationStatus === "validated") {
          progress.skipped += 1;
          progress.completed += 1;
          continue;
        }
        await storage.updatePatient(patient.id, {
          extractionStatus: "error",
          extractionError: errMsg,
          extractionErrorDetail: errDetail,
          updatedAt: now,
        });
        progress.failed += 1;
        progress.completed += 1;
      }
      progress.lastWarning = errMsg;
      options.onProgress({ ...progress });
      return progress;
    } else {
      const availableIds = new Set(discovery.models.map((m) => m.id));
      const requestedPrimary = (
        options.modelOverride ||
        settings.customModel ||
        settings.defaultModel ||
        ""
      ).trim();

      if (requestedPrimary && availableIds.has(requestedPrimary)) {
        activePrimaryModel = requestedPrimary;
      } else {
        activePrimaryModel = discovery.recommendedModel;
        if (requestedPrimary && requestedPrimary !== activePrimaryModel) {
          progress.lastWarning =
            "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.";
          await storage.saveSettings({
            defaultModel: activePrimaryModel,
            customModel: "",
          });
        }
      }

      const requestedFallback = (
        options.fallbackModelOverride ||
        settings.fallbackModel ||
        ""
      ).trim();

      if (
        requestedFallback &&
        requestedFallback !== activePrimaryModel &&
        availableIds.has(requestedFallback)
      ) {
        activeFallbackModel = requestedFallback;
      } else if (
        discovery.fallbackModel &&
        discovery.fallbackModel !== activePrimaryModel
      ) {
        activeFallbackModel = discovery.fallbackModel;
      } else {
        activeFallbackModel =
          discovery.models.find((m) => m.id !== activePrimaryModel)?.id ?? null;
      }

      progress.activeModel = activePrimaryModel;
    }
  }

  options.onProgress({ ...progress });

  // Snapshot del estado original de cada paciente para restaurarlo exactamente ante aborto
  const originalStatusById = new Map<
    string,
    {
      extractionStatus: Patient["extractionStatus"];
      extractionError?: string;
      extractionErrorDetail?: string;
    }
  >(
    options.patients.map((p) => [
      p.id,
      {
        extractionStatus: p.extractionStatus,
        extractionError: p.extractionError,
        extractionErrorDetail: p.extractionErrorDetail,
      },
    ])
  );

  // Pre-evaluar qué pacientes realmente necesitan procesamiento antes de marcar "queued"
  const existingByPatientId = new Map<string, Map<string, ExtractionRecord>>();
  const queuedIds = new Set<string>();
  const processedIds = new Set<string>();

  for (const patient of options.patients) {
    const existingAll = await storage.getPatientExtractions(patient.id);
    const existingByVar = new Map(existingAll.map((e) => [e.variableId, e]));
    existingByPatientId.set(patient.id, existingByVar);

    // Casos validados: jamás modificar su estado ni marcarlos como "queued"
    if (patient.validationStatus === "validated") {
      continue;
    }

    const missingVarDefs = options.variables.filter((v) => !existingByVar.has(v.id));

    // Paciente ya completado sin variables nuevas y sin re-extracción forzada -> conserva "done"
    if (
      !options.forceReextract &&
      !options.missingVariablesOnly &&
      patient.extractionStatus === "done" &&
      missingVarDefs.length === 0
    ) {
      continue;
    }

    const candidateTargetVars = options.missingVariablesOnly
      ? missingVarDefs
      : options.variables.filter((v) => {
          const prev = existingByVar.get(v.id);
          return !(prev?.manuallyEdited || prev?.status === "manual");
        });

    if (candidateTargetVars.length === 0) {
      continue;
    }

    queuedIds.add(patient.id);
    await storage.updatePatient(patient.id, {
      extractionStatus: "queued",
      extractionError: undefined,
      extractionErrorDetail: undefined,
    });
  }

  const restoreUnprocessedQueuedPatients = async () => {
    for (const pid of queuedIds) {
      if (processedIds.has(pid)) continue;
      const orig = originalStatusById.get(pid);
      if (!orig) continue;
      await storage.updatePatient(pid, {
        extractionStatus: orig.extractionStatus,
        extractionError: orig.extractionError,
        extractionErrorDetail: orig.extractionErrorDetail,
      });
    }
  };

  for (const patient of options.patients) {
    if (options.shouldAbort()) {
      await restoreUnprocessedQueuedPatients();
      break;
    }

    while (options.shouldPause()) {
      if (options.shouldAbort()) break;
      await sleepFn(250);
    }
    if (options.shouldAbort()) {
      await restoreUnprocessedQueuedPatients();
      break;
    }

    progress.currentPatientCode = patient.studyCode;
    progress.retryMessage = null;
    options.onProgress({ ...progress });

    try {
      const existingByVar =
        existingByPatientId.get(patient.id) ??
        new Map(
          (await storage.getPatientExtractions(patient.id)).map((e) => [e.variableId, e])
        );
      const isValidated = patient.validationStatus === "validated";
      const missingVarDefs = options.variables.filter((v) => !existingByVar.has(v.id));

      // Protección estricta: nunca sobrescribir casos ya validados por un médico
      if (isValidated) {
        if (!options.missingVariablesOnly || missingVarDefs.length === 0) {
          processedIds.add(patient.id);
          progress.skipped += 1;
          progress.completed += 1;
          options.onProgress({ ...progress });
          continue;
        }
      }

      // Evitar repetir innecesariamente una extracción que ya fue completada correctamente
      if (
        !isValidated &&
        !options.forceReextract &&
        !options.missingVariablesOnly &&
        patient.extractionStatus === "done" &&
        missingVarDefs.length === 0
      ) {
        processedIds.add(patient.id);
        progress.skipped += 1;
        progress.completed += 1;
        options.onProgress({ ...progress });
        continue;
      }

      const docs = await storage.getPatientDocuments(patient.id);

      if (docs.length === 0) {
        processedIds.add(patient.id);
        if (isValidated) {
          // No modificar metadatos de un paciente validado; omitirlo de forma segura
          progress.skipped += 1;
          progress.completed += 1;
          options.onProgress({ ...progress });
          continue;
        }
        progress.failed += 1;
        progress.completed += 1;
        await storage.updatePatient(patient.id, {
          extractionStatus: "error",
          extractionError: "Este paciente no tiene historias clínicas cargadas.",
          extractionErrorDetail: undefined,
        });
        options.onProgress({ ...progress });
        continue;
      }

      // Verificar PDFs escaneados, confirmación de redacción y disponibilidad de texto redactado (sin fallback a rawText)
      const scannedPdfDocs = docs.filter((d) => isDocumentLowTextPdf(d));
      const nonScannedDocs = docs.filter((d) => !isDocumentLowTextPdf(d));

      const unconfirmedDocs = nonScannedDocs.filter(
        (d) => d.redactionConfirmed !== true
      );

      if (unconfirmedDocs.length > 0) {
        processedIds.add(patient.id);
        if (isValidated) {
          progress.skipped += 1;
          progress.completed += 1;
          options.onProgress({ ...progress });
          continue;
        }
        const unconfirmedMsg =
          unconfirmedDocs.length === 1
            ? "Extracción bloqueada: falta confirmar la redacción de 1 documento clínico. Revisá la vista previa y confirmá la protección de datos antes de analizar."
            : `Extracción bloqueada: falta confirmar la redacción de ${unconfirmedDocs.length} documentos clínicos. Revisá la vista previa y confirmá la protección de datos antes de analizar.`;
        progress.failed += 1;
        progress.completed += 1;
        progress.lastWarning = unconfirmedMsg;
        await storage.updatePatient(patient.id, {
          extractionStatus: "error",
          extractionError: unconfirmedMsg,
          extractionErrorDetail: `Documento(s) sin redacción confirmada: ${unconfirmedDocs
            .map((d) => d.filename)
            .join(", ")}`,
        });
        options.onProgress({ ...progress });
        continue;
      }

      const missingRedactedDocs: ClinicalDocument[] = [];
      const readableDocs: ClinicalDocument[] = [];
      for (const d of nonScannedDocs) {
        if (hasUsableRedactedText(d.redactedText, MIN_SELECTABLE_TEXT_LENGTH)) {
          readableDocs.push(d);
        } else {
          missingRedactedDocs.push(d);
        }
      }

      if (readableDocs.length === 0) {
        processedIds.add(patient.id);
        if (isValidated) {
          // No modificar metadatos de un paciente validado; omitirlo de forma segura
          progress.skipped += 1;
          progress.completed += 1;
          options.onProgress({ ...progress });
          continue;
        }
        progress.failed += 1;
        progress.completed += 1;
        const blockedMsg =
          missingRedactedDocs.length > 0
            ? "Extracción bloqueada: no hay texto redactado disponible para enviar al modelo. Reaplicá la protección de datos y confirmá la redacción."
            : scannedPdfDocs.length > 0
              ? `${SCANNED_PDF_WARNING}. No se inició la extracción automática con texto vacío.`
              : "Los documentos del paciente no contienen texto redactado suficiente para analizar.";
        progress.lastWarning = blockedMsg;
        await storage.updatePatient(patient.id, {
          extractionStatus: "error",
          extractionError: blockedMsg,
          extractionErrorDetail:
            missingRedactedDocs.length > 0
              ? `Documento(s) sin texto redactado disponible: ${missingRedactedDocs
                  .map((d) => d.filename)
                  .join(", ")}`
              : scannedPdfDocs.length > 0
                ? `Archivo(s) sin texto seleccionable: ${scannedPdfDocs
                    .map((d) => d.filename)
                    .join(", ")}`
                : undefined,
        });
        options.onProgress({ ...progress });
        continue;
      }

      // Determinar qué variables extraer protegiendo SIEMPRE datos validados o editados manualmente
      let targetVariables: StudyVariable[];
      if (options.missingVariablesOnly || isValidated) {
        targetVariables = missingVarDefs;
      } else {
        targetVariables = options.variables.filter((v) => {
          const prev = existingByVar.get(v.id);
          return !(prev?.manuallyEdited || prev?.status === "manual");
        });
      }

      if (targetVariables.length === 0) {
        processedIds.add(patient.id);
        progress.skipped += 1;
        progress.completed += 1;
        options.onProgress({ ...progress });
        continue;
      }

      if (!isValidated) {
        await storage.updatePatient(patient.id, {
          extractionStatus: "processing",
          extractionError: undefined,
          extractionErrorDetail: undefined,
        });
      }

      const aliasToDoc = new Map<string, ClinicalDocument>();
      const payloadDocuments = readableDocs.map((d, idx) => {
        const neutralId = formatNeutralDocumentId(idx);
        aliasToDoc.set(neutralId, d);
        return {
          id: d.id,
          filename: neutralId,
          category: d.category,
          redactedText: d.redactedText,
          redactionConfirmed: true,
        };
      });

      const callResult = await callExtractWithRetriesAndFallback({
        basePayload: {
          studyName: options.study.name,
          apiKey: settings.geminiApiKey,
          forceMock: effectiveForceMock,
          redactionEnabled: true,
          redactionConfirmed: true,
          variables: targetVariables,
          documents: payloadDocuments,
        },
        primaryModel: activePrimaryModel,
        fallbackModel: activeFallbackModel,
        manualApiKey: settings.geminiApiKey,
        forceMock: effectiveForceMock,
        shouldAbort: options.shouldAbort,
        onRetry: (retryMsg) => {
          progress.retryMessage = retryMsg;
          options.onProgress({ ...progress });
        },
        fetchFn,
        retryDelaysMs,
        sleepFn,
      });

      const apiResponse = callResult.response;

      if (callResult.updatedPrimaryModel) {
        activePrimaryModel = callResult.updatedPrimaryModel;
        progress.activeModel = activePrimaryModel;
        await storage.saveSettings({
          defaultModel: activePrimaryModel,
          customModel: "",
        });
      }
      if (callResult.updatedFallbackModel !== undefined) {
        activeFallbackModel = callResult.updatedFallbackModel;
      }

      progress.lastMode = apiResponse.mode;
      if (callResult.notice) {
        progress.lastWarning = callResult.notice;
      } else if (apiResponse.warning) {
        progress.lastWarning = apiResponse.warning;
      }

      const now = new Date().toISOString();
      const recordsToPut: ExtractionRecord[] = [];
      let returnedTargetVars = 0;
      const omittedVarLabels: string[] = [];

      for (const variable of targetVariables) {
        const prev = existingByVar.get(variable.id);

        // Segunda barrera defensiva: jamás sobrescribir ediciones manuales o valores existentes de casos validados
        if (prev?.manuallyEdited || prev?.status === "manual") {
          returnedTargetVars += 1;
          continue;
        }
        if (isValidated && prev) {
          returnedTargetVars += 1;
          continue;
        }

        const out = apiResponse.extractions?.[variable.technicalName];
        if (!out || typeof out !== "object") {
          omittedVarLabels.push(variable.label || variable.technicalName);
          continue;
        }
        returnedTargetVars += 1;

        const source = findSourceDocumentId(
          readableDocs,
          out.source_document ?? null,
          out.evidence_quote ?? null,
          aliasToDoc
        );

        recordsToPut.push({
          id: prev?.id ?? generateId(),
          studyId: options.study.id,
          patientId: patient.id,
          variableId: variable.id,
          value: out.value,
          status: out.status === "extracted" && out.value !== null ? "extracted" : "missing",
          confidence: out.confidence ?? "baja",
          evidenceQuote: out.evidence_quote ?? null,
          sourceDocumentId: source.id,
          sourceDocumentName: source.name,
          reasoning: out.reasoning ?? null,
          manuallyEdited: false,
          modelUsed: apiResponse.modelUsed,
          updatedAt: now,
        });
      }

      // Una respuesta vacía (0 variables devueltas de las solicitadas) nunca es una extracción exitosa
      if (returnedTargetVars === 0 && targetVariables.length > 0) {
        throw new ExtractionApiError({
          userMessage:
            "El servicio de IA devolvió una respuesta vacía sin evaluar las variables solicitadas. Intentá analizar nuevamente este paciente.",
          technicalDetail: `El modelo ${apiResponse.modelUsed} devolvió 0 de ${targetVariables.length} variables solicitadas.`,
          status: 502,
          code: "empty_response",
          retryable: true,
        });
      }

      // No presentar una extracción parcial o con variables/documentos omitidos como completamente exitosa
      const hasUnreadableScannedDocs = scannedPdfDocs.length > 0;
      const hasMissingRedactedDocs = missingRedactedDocs.length > 0;
      const hasOmittedVars =
        returnedTargetVars < targetVariables.length ||
        Boolean(apiResponse.omittedVariables && apiResponse.omittedVariables.length > 0);
      const isPartial =
        hasUnreadableScannedDocs || hasMissingRedactedDocs || hasOmittedVars;

      const partialReasons: string[] = [];
      if (hasUnreadableScannedDocs) {
        partialReasons.push(
          `se omitió ${scannedPdfDocs
            .map((d) => `"${d.filename}"`)
            .join(", ")} porque parece un PDF escaneado sin texto seleccionable`
        );
      }
      if (hasMissingRedactedDocs) {
        partialReasons.push(
          `no se envió ${missingRedactedDocs
            .map((d) => `"${d.filename}"`)
            .join(", ")} porque no tenía texto redactado disponible`
        );
      }
      if (hasOmittedVars) {
        partialReasons.push(
          `el servicio de IA omitió ${
            omittedVarLabels.length || apiResponse.omittedVariables?.length || 1
          } variable(s) solicitada(s)`
        );
      }
      const partialNotice =
        partialReasons.length > 0
          ? `Extracción parcial: ${partialReasons.join("; ")}.`
          : undefined;

      // Para pacientes validados en modo "Solo Variables Nuevas": guardar solo las variables nuevas
      // sin modificar NINGÚN metadato protegido del paciente (extractionStatus, extractionError, lastExtractedAt, etc.)
      const patientPatch: Partial<Patient> = isValidated
        ? {}
        : {
            extractionStatus: isPartial ? "partial" : "done",
            extractionError: partialNotice,
            extractionErrorDetail: undefined,
            lastExtractedAt: now,
            updatedAt: now,
          };

      await storage.savePatientExtractionResult({
        patientId: patient.id,
        records: recordsToPut,
        patientPatch,
      });

      processedIds.add(patient.id);
      if (isPartial) {
        progress.partial += 1;
      } else {
        progress.succeeded += 1;
      }
      progress.completed += 1;
      progress.retryMessage = null;
      options.onProgress({ ...progress });

      // Pausa suave entre pacientes para cuidar cuota
      if (settings.rateLimitDelayMs > 0 && progress.completed < progress.total) {
        await sleepFn(settings.rateLimitDelayMs);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "ABORTED_BY_USER") {
        // Restaurar el paciente actual y todos los pendientes a su estado exacto original
        await restoreUnprocessedQueuedPatients();
        progress.retryMessage = null;
        options.onProgress({ ...progress });
        break;
      }

      processedIds.add(patient.id);

      let userMessage: string;
      let technicalDetail: string | undefined;
      if (err instanceof ExtractionApiError) {
        userMessage = err.userMessage;
        technicalDetail = err.technicalDetail;
      } else {
        const formatted = classifyAndFormatAiError(err);
        userMessage = formatted.userMessage;
        technicalDetail = formatted.technicalDetail;
      }

      if (patient.validationStatus !== "validated") {
        await storage.updatePatient(patient.id, {
          extractionStatus: "error",
          extractionError: userMessage,
          extractionErrorDetail: technicalDetail,
          updatedAt: new Date().toISOString(),
        });
      }
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
