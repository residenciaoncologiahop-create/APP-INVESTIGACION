import { GoogleGenAI } from "@google/genai";
import { classifyAndFormatAiError } from "./ai-errors";
import {
  discoverGeminiModels,
  isAllowedGeminiModelId,
  type DiscoverModelsParams,
} from "./gemini-models";
import {
  formatNeutralDocumentId,
  hasUsableRedactedText,
  toNeutralDocumentId,
} from "./redactor";
import {
  buildClinicalSystemPrompt,
  buildGeminiResponseSchema,
} from "./schema-builder";
import type {
  GeminiExtractionResponse,
  GeminiModel,
  GeminiVariableExtractionOutput,
  ModelsDiscoveryResponse,
  StudyVariable,
} from "./types";

const MIN_USABLE_CLINICAL_TEXT_CHARS = 30;

export interface ExtractRequestDocument {
  id: string;
  filename: string;
  category: string;
  redactedText: string;
  redactionConfirmed: boolean;
}

export interface SanitizedModelDocument {
  id: string;
  filename: string;
  category: string;
  text: string;
}

export interface ExtractRequestBody {
  studyName: string;
  model?: GeminiModel;
  apiKey?: string;
  forceMock?: boolean;
  redactionEnabled?: boolean;
  redactionConfirmed?: boolean;
  variables: StudyVariable[];
  documents: ExtractRequestDocument[];
}

function resolveSafeRedactedText(doc: ExtractRequestDocument): string {
  // El servidor acepta únicamente el campo explícito redactedText; nunca usa text ni rawText como alternativa.
  return typeof doc.redactedText === "string" ? doc.redactedText : "";
}

function sanitizeDocumentsForModel(
  docs: ExtractRequestDocument[]
): SanitizedModelDocument[] {
  const usedIds = new Set<string>();
  let nextSeq = 0;

  return docs.map((doc, idx) => {
    let neutralId = toNeutralDocumentId(doc.filename, idx);
    while (usedIds.has(neutralId)) {
      nextSeq += 1;
      neutralId = formatNeutralDocumentId(nextSeq);
    }
    usedIds.add(neutralId);
    return {
      id: doc.id,
      filename: neutralId,
      category: doc.category,
      text: resolveSafeRedactedText(doc),
    };
  });
}

export interface ExtractServiceDependencies {
  serverApiKey?: string;
  generateContent?: (params: {
    apiKey: string;
    model: string;
    contents: string;
    systemInstruction: string;
    responseJsonSchema: unknown;
  }) => Promise<{ text?: string }>;
  discoverModels?: (params: DiscoverModelsParams) => Promise<ModelsDiscoveryResponse>;
}

export interface ExtractServiceResult {
  status: number;
  body:
    | GeminiExtractionResponse
    | {
        error: string;
        technicalDetail?: string;
        code?: string;
        retryable?: boolean;
        modelAutoUpdated?: boolean;
        resolvedModel?: string;
        suggestedFallbackModel?: string;
      };
}

function findSentenceWithMatch(text: string, matchIndex: number, matchLength: number): string {
  const startBound = Math.max(0, text.lastIndexOf("\n", matchIndex));
  let endBound = text.indexOf("\n", matchIndex + matchLength);
  if (endBound === -1) endBound = text.length;
  let snippet = text.slice(startBound, endBound).trim();
  if (snippet.length > 220) {
    const relStart = Math.max(0, matchIndex - startBound - 40);
    snippet = snippet.slice(relStart, relStart + 200).trim();
  }
  return snippet;
}

/**
 * Extractor heurístico local (Modo de demostración) para pruebas sin clave de IA.
 * Garantiza citas textuales reales tomadas del texto del documento.
 */
export function runLocalMockExtraction(
  variables: StudyVariable[],
  documents: SanitizedModelDocument[]
): Record<string, GeminiVariableExtractionOutput> {
  const results: Record<string, GeminiVariableExtractionOutput> = {};

  const searchInDocs = (
    regex: RegExp
  ): { match: RegExpMatchArray; doc: SanitizedModelDocument } | null => {
    for (const doc of documents) {
      const m = doc.text.match(regex);
      if (m && m.index !== undefined) {
        return { match: m, doc };
      }
    }
    return null;
  };

  for (const variable of variables) {
    const key = variable.technicalName;
    const hint = `${variable.technicalName} ${variable.label} ${variable.aiInstruction}`.toLowerCase();

    if (variable.type === "numeric" && /edad|age|años/.test(hint)) {
      const found = searchInDocs(/\b(\d{2})\s*a[ñn]os\b/i);
      if (found && found.match.index !== undefined) {
        results[key] = {
          value: Number(found.match[1]),
          status: "extracted",
          confidence: "alta",
          evidence_quote: findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length),
          source_document: found.doc.filename,
          reasoning: "Extraído en modo de demostración local (sin IA conectada).",
        };
        continue;
      }
    }

    if (/ecog|performance/.test(hint)) {
      const found = searchInDocs(/\bECOG\s*[:=]?\s*([0-4])\b/i);
      if (found && found.match.index !== undefined) {
        const val = found.match[1];
        const finalVal =
          variable.type === "numeric"
            ? Number(val)
            : variable.options.includes(val)
              ? val
              : val;
        results[key] = {
          value: finalVal,
          status: "extracted",
          confidence: "alta",
          evidence_quote: findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length),
          source_document: found.doc.filename,
          reasoning: null,
        };
        continue;
      }
    }

    if (/sexo|genero|género/.test(hint)) {
      const fem = searchInDocs(/\b(mujer|femenin[oa]|paciente\s+femenin[oa])\b/i);
      const masc = searchInDocs(/\b(var[oó]n|masculin[oa]|hombre)\b/i);
      const picked = fem ?? masc;
      if (picked && picked.match.index !== undefined) {
        const isFem = Boolean(fem);
        const value =
          variable.options.find((o) =>
            isFem ? /^f|muj/i.test(o) : /^m|var|hom/i.test(o)
          ) ?? (isFem ? "Femenino" : "Masculino");
        results[key] = {
          value,
          status: "extracted",
          confidence: "alta",
          evidence_quote: findSentenceWithMatch(picked.doc.text, picked.match.index, picked.match[0].length),
          source_document: picked.doc.filename,
          reasoning: null,
        };
        continue;
      }
    }

    if (variable.type === "date") {
      let pattern = /(\d{2}\/\d{2}\/\d{4})/;
      if (/diagn[oó]stico|patol|biops/.test(hint)) {
        pattern = /(?:patol[oó]g\w*|informe\s+confirmatorio|biopsia[^.\n]{0,40}|diagn[oó]stico[^.\n]{0,30})\s*[:(]?\s*(\d{2}\/\d{2}\/\d{4})/i;
      } else if (/[oó]bito|fallec|defunc/.test(hint)) {
        pattern = /(?:fallece|falleci[oó]|[oó]bito|defunci[oó]n)[^.\n]{0,25}(\d{2}\/\d{2}\/\d{4})/i;
      } else if (/[uú]ltimo\s+control|control\s+m[aá]s\s+reciente/.test(hint)) {
        pattern = /(?:[uú]ltimo\s+control|control\s+m[aá]s\s+reciente|fallece)[^.\n]{0,30}(\d{2}\/\d{2}\/\d{4})/i;
      } else if (/progresi[oó]n/.test(hint)) {
        pattern = /progresi[oó]n[^.\n]{0,35}(\d{2}\/\d{2}\/\d{4})/i;
      } else if (/inicio|l[ií]nea/.test(hint)) {
        pattern = /(?:inicia|comienza|inicio)[^.\n]{0,35}(\d{2}\/\d{2}\/\d{4})/i;
      }
      const found = searchInDocs(pattern);
      if (found && found.match.index !== undefined) {
        results[key] = {
          value: found.match[1],
          status: "extracted",
          confidence: "media",
          evidence_quote: findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length),
          source_document: found.doc.filename,
          reasoning: "Fecha detectada en modo de demostración; verificar con revisión médica.",
        };
        continue;
      }
    }

    if (
      (variable.type === "categorical_single" ||
        variable.type === "categorical_multiple") &&
      variable.options.length > 0
    ) {
      const matchedOptions: string[] = [];
      let firstDoc: SanitizedModelDocument | null = null;
      let firstQuote: string | null = null;

      for (const opt of variable.options) {
        const tokens = opt
          .split(/[/()]/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2);
        for (const tok of tokens) {
          const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const found = searchInDocs(new RegExp(`\\b${escaped}\\b`, "i"));
          if (found && found.match.index !== undefined) {
            if (!matchedOptions.includes(opt)) matchedOptions.push(opt);
            if (!firstDoc) {
              firstDoc = found.doc;
              firstQuote = findSentenceWithMatch(
                found.doc.text,
                found.match.index,
                found.match[0].length
              );
            }
            break;
          }
        }
      }

      if (matchedOptions.length > 0 && firstDoc) {
        results[key] = {
          value:
            variable.type === "categorical_multiple"
              ? matchedOptions
              : matchedOptions[0],
          status: "extracted",
          confidence: "media",
          evidence_quote: firstQuote,
          source_document: firstDoc.filename,
          reasoning: "Coincidencia detectada en modo de demostración; revisar contexto clínico.",
        };
        continue;
      }
    }

    if (variable.type === "boolean") {
      if (/toxic|grado\s*3|g3/.test(hint)) {
        const neg = searchInDocs(/no\s+se\s+registraron\s+toxicidades\s+grado\s*3|sin\s+toxicidad\s+grado\s*3/i);
        if (neg && neg.match.index !== undefined) {
          results[key] = {
            value: "No",
            status: "extracted",
            confidence: "alta",
            evidence_quote: findSentenceWithMatch(neg.doc.text, neg.match.index, neg.match[0].length),
            source_document: neg.doc.filename,
            reasoning: null,
          };
          continue;
        }
        const pos = searchInDocs(/grado\s*[345]\b|G[345]\b/i);
        if (pos && pos.match.index !== undefined) {
          results[key] = {
            value: "Sí",
            status: "extracted",
            confidence: "media",
            evidence_quote: findSentenceWithMatch(pos.doc.text, pos.match.index, pos.match[0].length),
            source_document: pos.doc.filename,
            reasoning: null,
          };
          continue;
        }
      }
    }

    if (variable.type === "text") {
      if (/biomarc|molec|egfr|alk|pdl1|pd-l1/.test(hint)) {
        const found = searchInDocs(/(?:EGFR|ALK|KRAS|PD-L1|HER2|BRCA)[^\n]{5,140}/i);
        if (found && found.match.index !== undefined) {
          const quote = findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length);
          results[key] = {
            value: found.match[0].trim().slice(0, 120),
            status: "extracted",
            confidence: "media",
            evidence_quote: quote,
            source_document: found.doc.filename,
            reasoning: "Extracto molecular obtenido en modo de demostración.",
          };
          continue;
        }
      }
      if (/esquema|linea|tratamiento|droga/.test(hint)) {
        const found = searchInDocs(/(?:primera\s+l[ií]nea|1ra\s+l[ií]nea)[^\n]{5,140}/i);
        if (found && found.match.index !== undefined) {
          const quote = findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length);
          results[key] = {
            value: found.match[0].trim().slice(0, 120),
            status: "extracted",
            confidence: "media",
            evidence_quote: quote,
            source_document: found.doc.filename,
            reasoning: "Extracto terapéutico obtenido en modo de demostración.",
          };
          continue;
        }
      }
    }

    results[key] = {
      value: null,
      status: "missing",
      confidence: "baja",
      evidence_quote: null,
      source_document: null,
      reasoning:
        "No se halló evidencia explícita en modo de demostración. Conectá la IA en Configuración y Respaldo para un análisis clínico completo.",
    };
  }

  return results;
}

async function defaultGenerateContent(params: {
  apiKey: string;
  model: string;
  contents: string;
  systemInstruction: string;
  responseJsonSchema: unknown;
}): Promise<{ text?: string }> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const response = await ai.models.generateContent({
    model: params.model,
    contents: params.contents,
    config: {
      systemInstruction: params.systemInstruction,
      temperature: 0.1,
      responseMimeType: "application/json",
      responseJsonSchema: params.responseJsonSchema,
    },
  });
  return { text: response.text };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normaliza exclusivamente las variables realmente devueltas por el modelo.
 * Diferencia entre:
 * - variable evaluada sin evidencia (status: "missing" / value: null) -> se conserva como "missing"
 * - variable omitida o malformada en la respuesta -> se registra en omittedVariables sin fabricar un "missing" falso.
 */
function normalizeExtractions(
  variables: StudyVariable[],
  rawMap: Record<string, unknown>
): {
  normalized: Record<string, GeminiVariableExtractionOutput>;
  omittedVariables: string[];
  malformedVariables: string[];
} {
  const normalized: Record<string, GeminiVariableExtractionOutput> = {};
  const omittedVariables: string[] = [];
  const malformedVariables: string[] = [];

  for (const v of variables) {
    if (!Object.prototype.hasOwnProperty.call(rawMap, v.technicalName)) {
      omittedVariables.push(v.technicalName);
      continue;
    }

    const rawCell = rawMap[v.technicalName];
    if (!isPlainRecord(rawCell)) {
      malformedVariables.push(v.technicalName);
      omittedVariables.push(v.technicalName);
      continue;
    }

    const cell = rawCell as Partial<GeminiVariableExtractionOutput>;
    const hasExplicitStatus = cell.status === "extracted" || cell.status === "missing";
    const hasValueField = Object.prototype.hasOwnProperty.call(rawCell, "value");

    if (!hasExplicitStatus && !hasValueField) {
      malformedVariables.push(v.technicalName);
      omittedVariables.push(v.technicalName);
      continue;
    }

    if (cell.status === "missing" || cell.value === null || cell.value === undefined) {
      normalized[v.technicalName] = {
        value: null,
        status: "missing",
        confidence:
          cell.confidence === "alta" ||
          cell.confidence === "media" ||
          cell.confidence === "baja"
            ? cell.confidence
            : "baja",
        evidence_quote: null,
        source_document: null,
        reasoning: typeof cell.reasoning === "string" ? cell.reasoning : null,
      };
    } else {
      normalized[v.technicalName] = {
        value: cell.value,
        status: "extracted",
        confidence:
          cell.confidence === "alta" ||
          cell.confidence === "media" ||
          cell.confidence === "baja"
            ? cell.confidence
            : "media",
        evidence_quote: typeof cell.evidence_quote === "string" ? cell.evidence_quote : null,
        source_document: typeof cell.source_document === "string" ? cell.source_document : null,
        reasoning: typeof cell.reasoning === "string" ? cell.reasoning : null,
      };
    }
  }

  return { normalized, omittedVariables, malformedVariables };
}

export async function executeClinicalExtraction(
  body: ExtractRequestBody,
  deps: ExtractServiceDependencies = {}
): Promise<ExtractServiceResult> {
  if (!body.variables || body.variables.length === 0) {
    return {
      status: 400,
      body: {
        error: "Definí al menos una variable del estudio antes de iniciar la extracción.",
        retryable: false,
      },
    };
  }

  if (!body.documents || body.documents.length === 0) {
    return {
      status: 400,
      body: {
        error: "Este paciente no tiene historias clínicas cargadas.",
        retryable: false,
      },
    };
  }

  if (body.redactionEnabled !== true) {
    return {
      status: 422,
      body: {
        error:
          "La protección mínima de datos identificatorios no está habilitada en la solicitud. Activá las reglas obligatorias de redacción antes de iniciar la extracción.",
        technicalDetail:
          "Solicitud rechazada: se requiere redactionEnabled === true.",
        code: "redaction_disabled",
        retryable: false,
      },
    };
  }

  const allDocsConfirmed = body.documents.every(
    (doc) => doc.redactionConfirmed === true
  );

  if (body.redactionConfirmed !== true || !allDocsConfirmed) {
    return {
      status: 422,
      body: {
        error:
          "La extracción está bloqueada: se requiere confirmación explícita de la redacción en la solicitud y en todos los documentos clínicos.",
        technicalDetail:
          "Solicitud rechazada: se requiere redactionConfirmed === true en la solicitud y en cada documento.",
        code: "redaction_unconfirmed",
        retryable: false,
      },
    };
  }

  // No iniciar una extracción clínica si no existe redactedText usable (sin alternativa ni fallback a text/rawText)
  const docsWithUsableRedactedText = body.documents.filter((doc) =>
    hasUsableRedactedText(
      resolveSafeRedactedText(doc),
      MIN_USABLE_CLINICAL_TEXT_CHARS
    )
  );

  if (docsWithUsableRedactedText.length === 0) {
    return {
      status: 422,
      body: {
        error:
          "No hay texto redactado (redactedText) disponible o suficiente para enviar al modelo. Verificá que el documento no sea un PDF escaneado y que la redacción esté aplicada.",
        technicalDetail:
          "Todos los documentos enviados carecen de redactedText o contienen menos de 30 caracteres usables.",
        code: "missing_redacted_text",
        retryable: false,
      },
    };
  }

  const sanitizedDocs = sanitizeDocumentsForModel(docsWithUsableRedactedText);

  const manualKey = (body.apiKey ?? "").trim();
  const serverKey = (deps.serverApiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
  const effectiveApiKey = manualKey || serverKey;

  if (body.forceMock || !effectiveApiKey) {
    const mockExtractions = runLocalMockExtraction(body.variables, sanitizedDocs);
    const response: GeminiExtractionResponse = {
      extractions: mockExtractions,
      mode: "mock",
      modelUsed: "modo-demostracion-local",
      warning: body.forceMock
        ? "Resultados generados en modo de demostración (sin conexión a IA). Verificá cada dato en la revisión médica."
        : "No hay una clave de IA configurada. Se ejecutó el modo de demostración local.",
    };
    return { status: 200, body: response };
  }

  const discoverFn = deps.discoverModels ?? discoverGeminiModels;
  const generateFn = deps.generateContent ?? defaultGenerateContent;

  let activeModel = (body.model ?? "").trim();
  let modelAutoUpdated = false;
  let autoUpdateWarning: string | undefined;
  let suggestedFallbackModel: string | undefined;

  // Rechazar cualquier modelo fuera de la allowlist del servidor antes de invocar Gemini
  if (activeModel && !isAllowedGeminiModelId(activeModel)) {
    return {
      status: 400,
      body: {
        error:
          "El modelo de IA solicitado no está habilitado por la política de seguridad del servidor.",
        technicalDetail: "Modelo rechazado por allowlist del servidor.",
        code: "model_not_allowed",
        retryable: false,
      },
    };
  }

  // Si no hay modelo seleccionado, descubrir automáticamente el modelo recomendado
  if (!activeModel) {
    const discovery = await discoverFn({
      manualApiKey: manualKey,
      serverApiKey: serverKey,
    });
    if (
      !discovery.authenticated ||
      !discovery.recommendedModel ||
      !isAllowedGeminiModelId(discovery.recommendedModel)
    ) {
      const status = discovery.error?.includes("clave") ? 401 : 503;
      return {
        status,
        body: {
          error:
            discovery.error ||
            "No se encontraron modelos de IA permitidos disponibles en este momento. Revisá la configuración.",
          technicalDetail: "No hay modelos aprobados disponibles en el proveedor.",
          code: status === 401 ? "auth" : "no_models",
          retryable: status >= 500,
        },
      };
    }
    activeModel = discovery.recommendedModel;
    if (
      discovery.fallbackModel &&
      discovery.fallbackModel !== activeModel &&
      isAllowedGeminiModelId(discovery.fallbackModel)
    ) {
      suggestedFallbackModel = discovery.fallbackModel;
    }
  }

  const systemInstruction = buildClinicalSystemPrompt(
    body.studyName || "Estudio Oncológico",
    body.variables
  );
  const responseJsonSchema = buildGeminiResponseSchema(body.variables);

  const formattedDocuments = sanitizedDocs
    .map(
      (doc, idx) =>
        `=== [DOCUMENTO ${idx + 1}: ${doc.filename} | Categoría: ${doc.category}] ===\n${doc.text}\n=== [FIN DOCUMENTO: ${doc.filename}] ===`
    )
    .join("\n\n");

  const userPrompt = `Analiza los siguientes documentos clínicos seudoanonimizados pertenecientes a un único paciente y extrae estrictamente las variables del diccionario según las reglas establecidas.\n\n${formattedDocuments}`;

  const invokeModel = async (modelId: string) =>
    generateFn({
      apiKey: effectiveApiKey,
      model: modelId,
      contents: userPrompt,
      systemInstruction,
      responseJsonSchema,
    });

  let aiResponse: { text?: string };
  try {
    aiResponse = await invokeModel(activeModel);
  } catch (err: unknown) {
    const classified = classifyAndFormatAiError(err);

    // Ante error 404 (modelo inexistente/obsoleto), descubrir y reintentar automáticamente con el recomendado
    if (classified.code === "not_found") {
      const discovery = await discoverFn({
        manualApiKey: manualKey,
        serverApiKey: serverKey,
      });

      const replacement =
        discovery.recommendedModel &&
        discovery.recommendedModel !== activeModel &&
        isAllowedGeminiModelId(discovery.recommendedModel)
          ? discovery.recommendedModel
          : discovery.fallbackModel &&
              discovery.fallbackModel !== activeModel &&
              isAllowedGeminiModelId(discovery.fallbackModel)
            ? discovery.fallbackModel
            : null;

      if (discovery.authenticated && replacement) {
        const nextFallback =
          discovery.fallbackModel &&
          discovery.fallbackModel !== replacement &&
          isAllowedGeminiModelId(discovery.fallbackModel)
            ? discovery.fallbackModel
            : discovery.models.find(
                (m) => m.id !== replacement && isAllowedGeminiModelId(m.id)
              )?.id;

        try {
          activeModel = replacement;
          suggestedFallbackModel = nextFallback;
          modelAutoUpdated = true;
          autoUpdateWarning =
            "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente.";
          aiResponse = await invokeModel(activeModel);
        } catch (retryErr: unknown) {
          const retryFormatted = classifyAndFormatAiError(retryErr);
          return {
            status: retryFormatted.status,
            body: {
              error: retryFormatted.userMessage,
              technicalDetail: `Error del proveedor de IA (${retryFormatted.code}, HTTP ${retryFormatted.status}).`,
              code: retryFormatted.code,
              retryable: retryFormatted.retryable,
              // Informar al cliente el reemplazo ya resuelto para evitar que reintente con el modelo obsoleto
              modelAutoUpdated: true,
              resolvedModel: activeModel,
              ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
            },
          };
        }
      } else {
        return {
          status: 404,
          body: {
            error:
              discovery.error ||
              "El modelo seleccionado ya no está disponible y no se encontró un reemplazo automático permitido.",
            technicalDetail: "Modelo no disponible en el proveedor (HTTP 404).",
            code: "not_found",
            retryable: false,
          },
        };
      }
    } else {
      return {
        status: classified.status,
        body: {
          error: classified.userMessage,
          technicalDetail: `Error del proveedor de IA (${classified.code}, HTTP ${classified.status}).`,
          code: classified.code,
          retryable: classified.retryable,
          ...(modelAutoUpdated
            ? {
                modelAutoUpdated: true,
                resolvedModel: activeModel,
                ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
              }
            : {}),
        },
      };
    }
  }

  const rawText = aiResponse.text;
  if (!rawText || !rawText.trim()) {
    return {
      status: 502,
      body: {
        error:
          "El servicio de IA devolvió una respuesta vacía. Intentá analizar nuevamente este paciente.",
        technicalDetail: `Respuesta vacía del modelo ${activeModel}.`,
        code: "empty_response",
        retryable: true,
        ...(modelAutoUpdated
          ? {
              modelAutoUpdated: true,
              resolvedModel: activeModel,
              ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
            }
          : {}),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      status: 502,
      body: {
        error:
          "El servicio de IA devolvió una respuesta malformada. Intentá analizar nuevamente este paciente.",
        technicalDetail: "Error al interpretar la respuesta JSON del modelo.",
        code: "parse_error",
        retryable: true,
        ...(modelAutoUpdated
          ? {
              modelAutoUpdated: true,
              resolvedModel: activeModel,
              ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
            }
          : {}),
      },
    };
  }

  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.extractions)) {
    return {
      status: 502,
      body: {
        error:
          "El servicio de IA devolvió una respuesta malformada. Intentá analizar nuevamente este paciente.",
        technicalDetail: `La respuesta del modelo ${activeModel} no incluyó un objeto 'extractions' válido.`,
        code: "parse_error",
        retryable: true,
        ...(modelAutoUpdated
          ? {
              modelAutoUpdated: true,
              resolvedModel: activeModel,
              ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
            }
          : {}),
      },
    };
  }

  const { normalized, omittedVariables, malformedVariables } = normalizeExtractions(
    body.variables,
    parsed.extractions
  );

  const returnedCount = Object.keys(normalized).length;

  // Si el modelo devolvió {"extractions": {}} o 0 variables válidas -> error, nunca éxito
  if (returnedCount === 0) {
    const isMalformedAll = malformedVariables.length > 0;
    return {
      status: 502,
      body: {
        error: isMalformedAll
          ? "El servicio de IA devolvió una respuesta malformada. Intentá analizar nuevamente este paciente."
          : "El servicio de IA devolvió una respuesta vacía sin evaluar las variables solicitadas. Intentá analizar nuevamente este paciente.",
        technicalDetail: isMalformedAll
          ? `Todas las variables evaluadas por ${activeModel} tenían formato inválido (${malformedVariables.join(", ")}).`
          : `La respuesta de ${activeModel} devolvió 'extractions' sin ninguna de las ${body.variables.length} variables solicitadas.`,
        code: isMalformedAll ? "parse_error" : "empty_response",
        retryable: true,
        ...(modelAutoUpdated
          ? {
              modelAutoUpdated: true,
              resolvedModel: activeModel,
              ...(suggestedFallbackModel ? { suggestedFallbackModel } : {}),
            }
          : {}),
      },
    };
  }

  const warnings: string[] = [];
  if (autoUpdateWarning) warnings.push(autoUpdateWarning);
  if (omittedVariables.length > 0) {
    warnings.push(
      `Extracción incompleta: el modelo omitió ${omittedVariables.length} variable(s) solicitada(s).`
    );
  }

  const response: GeminiExtractionResponse = {
    extractions: normalized,
    mode: "gemini",
    modelUsed: activeModel,
    ...(omittedVariables.length > 0 ? { omittedVariables } : {}),
    ...(modelAutoUpdated
      ? {
          modelAutoUpdated: true,
          resolvedModel: activeModel,
        }
      : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };

  return { status: 200, body: response };
}
