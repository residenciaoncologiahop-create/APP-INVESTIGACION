import { GoogleGenAI, type Model } from "@google/genai";
import { classifyAndFormatAiError } from "./ai-errors";
import type { DiscoveredGeminiModel, ModelsDiscoveryResponse } from "./types";

const MAX_LIST_PAGES = 5;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const MAX_MODELS_CACHE_ENTRIES = 20;
const SAFE_MODEL_ID_REGEX = /^gemini-[a-z0-9._-]{1,64}$/i;

/**
 * Allowlist explícita por defecto de modelos Gemini aprobados para extracción clínica.
 * Puede personalizarse mediante la variable de entorno de servidor GEMINI_ALLOWED_MODELS
 * (lista separada por comas) sin aceptar modelos arbitrarios enviados por el cliente.
 */
export const DEFAULT_ALLOWED_GEMINI_MODELS: readonly string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

/**
 * Patrones sobre el ID del modelo que NO son adecuados para extracción clínica de texto estructurado
 * (embeddings, generación de imágenes/video/audio, modelos live/TTS/robótica/etc.).
 * Se evalúan sobre el ID técnico y no sobre displayName para evitar falsos positivos.
 */
const EXCLUDED_MODEL_ID_PATTERNS: RegExp[] = [
  /embed/i,
  /\baqa\b/i,
  /imagen/i,
  /\bveo\b/i,
  /image[-_]?gen|[-_]image(?:[-_]|$)/i,
  /^gemini-(?:1\.0-)?pro-vision/i,
  /audio/i,
  /\btts\b/i,
  /\blive\b/i,
  /robotics/i,
  /computer[-_]?use/i,
  /lyria/i,
  /learnlm/i,
  /\bgemma\b/i,
  /tuning/i,
  /moderation/i,
  /transcri/i,
  /speech/i,
  /deep[-_]?research/i,
];

export interface RawListedModel {
  name?: string;
  displayName?: string;
  description?: string;
  supportedActions?: string[];
  supportedGenerationMethods?: string[];
}

export type ModelsListProvider = (apiKey: string) => Promise<RawListedModel[]>;

/**
 * Consulta todos los modelos disponibles a través de la API oficial de Google
 * (`ai.models.list`) contemplando paginación explícita.
 */
export async function listAllModelsFromGoogle(apiKey: string): Promise<RawListedModel[]> {
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const collected: RawListedModel[] = [];

  let pageCount = 0;
  while (pageCount < MAX_LIST_PAGES) {
    pageCount += 1;
    const currentPage: Model[] = pager.page ?? [];
    for (const item of currentPage) {
      collected.push({
        name: item.name,
        displayName: item.displayName,
        description: item.description,
        supportedActions: item.supportedActions,
      });
    }
    if (!pager.hasNextPage()) {
      break;
    }
    await pager.nextPage();
  }

  return collected;
}

export function extractModelId(rawName?: string): string {
  if (!rawName) return "";
  return rawName.trim().replace(/^models\//i, "");
}

export function getAllowedGeminiModels(allowedModelsEnv?: string): Set<string> {
  const rawEnv = allowedModelsEnv ?? process.env.GEMINI_ALLOWED_MODELS ?? "";
  const candidates = rawEnv.trim()
    ? rawEnv.split(",").map((s) => extractModelId(s).toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_GEMINI_MODELS.map((s) => s.toLowerCase());

  const allowed = new Set<string>();
  for (const id of candidates) {
    if (!SAFE_MODEL_ID_REGEX.test(id)) continue;
    const isExcluded = EXCLUDED_MODEL_ID_PATTERNS.some((p) => p.test(id));
    if (!isExcluded) {
      allowed.add(id);
    }
  }
  return allowed;
}

export function isAllowedGeminiModelId(
  modelId: string | undefined | null,
  allowedModelsEnv?: string
): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const cleaned = modelId.trim();
  if (!cleaned || cleaned.includes("/") || cleaned.includes("..")) return false;
  if (!SAFE_MODEL_ID_REGEX.test(cleaned)) return false;
  if (EXCLUDED_MODEL_ID_PATTERNS.some((p) => p.test(cleaned))) return false;
  const allowlist = getAllowedGeminiModels(allowedModelsEnv);
  return allowlist.has(cleaned.toLowerCase());
}

/**
 * Determina si un modelo devuelto por `models.list` es un modelo Gemini apto
 * y aprobado por la allowlist del servidor para extracción clínica estructurada.
 */
export function isSuitableClinicalGeminiModel(
  model: RawListedModel,
  allowedModelsEnv?: string
): boolean {
  const id = extractModelId(model.name);
  if (!id) return false;

  // Debe pertenecer a la allowlist del servidor y a la familia Gemini
  if (!isAllowedGeminiModelId(id, allowedModelsEnv)) return false;

  // Debe soportar generateContent
  const actions = model.supportedActions ?? model.supportedGenerationMethods ?? [];
  const supportsGenerateContent = actions.some(
    (action) => action.toLowerCase() === "generatecontent"
  );
  if (!supportsGenerateContent) return false;

  return true;
}

interface ParsedModelTraits {
  major: number;
  minor: number;
  isFlash: boolean;
  isPro: boolean;
  isLite: boolean;
  isExperimentalOrThinking: boolean;
  isPreview: boolean;
  isDatedSnapshot: boolean;
  isLatestAlias: boolean;
}

function parseModelTraits(id: string): ParsedModelTraits {
  const lower = id.toLowerCase();
  const verMatch = lower.match(/^gemini-(\d+)(?:\.(\d+))?/);
  const major = verMatch ? Number(verMatch[1]) : 0;
  const minor = verMatch && verMatch[2] ? Number(verMatch[2]) : 0;

  return {
    major,
    minor,
    isFlash: /\bflash\b|-flash/.test(lower),
    isPro: /\bpro\b|-pro/.test(lower),
    isLite: /\blite\b|-lite/.test(lower),
    isExperimentalOrThinking: /(^|[-_])(exp|experimental|thinking)([-_]|$)/i.test(lower),
    isPreview: /(^|[-_])preview([-_]|$)/i.test(lower),
    isDatedSnapshot: /-\d{3,}$|-\d{2}-\d{4}$|-\d{4}-\d{2}-\d{2}$/.test(lower),
    isLatestAlias: /-latest$/i.test(lower),
  };
}

/**
 * Puntaje algorítmico para priorizar modelos disponibles sin depender de nombres hardcodeados.
 * Nunca prioriza modelos experimentales/thinking por sobre modelos estables compatibles con JSON Schema.
 */
function scoreForRecommended(id: string): number {
  const t = parseModelTraits(id);
  let score = 0;

  // Garantizar que modelos estables siempre estén por encima de experimentales/thinking (posible incompatibilidad con responseJsonSchema)
  if (!t.isExperimentalOrThinking) score += 20000;
  if (!t.isPreview) score += 5000;

  // Dentro de cada estabilidad, priorizar versión más reciente
  score += t.major * 1000 + t.minor * 100;

  // Preferir alias base sobre snapshots fechados o "-latest" genéricos
  if (!t.isDatedSnapshot) score += 60;
  if (!t.isLatestAlias) score += 20;

  // Para extracción clínica en lotes, Flash (no lite) ofrece el mejor equilibrio velocidad/precisión
  if (t.isFlash && !t.isLite) score += 120;
  else if (t.isPro) score += 90;
  else if (t.isFlash && t.isLite) score += 70;

  return score;
}

/**
 * Puntaje para elegir un segundo modelo distinto como respaldo ante saturación (503/429).
 * Favorece un modelo estable de distinta variante o versión respecto del recomendado.
 */
function scoreForFallback(candidateId: string, recommendedId: string): number {
  const cand = parseModelTraits(candidateId);
  const rec = parseModelTraits(recommendedId);

  let score = scoreForRecommended(candidateId);

  // Bonificar diversidad real frente al modelo principal (otro tier u otra versión)
  const sameTier =
    cand.isFlash === rec.isFlash &&
    cand.isPro === rec.isPro &&
    cand.isLite === rec.isLite;
  const sameVersion = cand.major === rec.major && cand.minor === rec.minor;

  if (!sameTier) score += 150;
  if (!sameVersion) score += 80;

  return score;
}

/**
 * Filtra, ordena y selecciona dinámicamente el modelo recomendado y el modelo alternativo
 * exclusivamente a partir de la lista real devuelta por la API.
 */
export function selectClinicalModels(rawModels: RawListedModel[]): {
  models: DiscoveredGeminiModel[];
  recommendedModel: string | null;
  fallbackModel: string | null;
} {
  const deduped = new Map<string, DiscoveredGeminiModel>();

  for (const raw of rawModels) {
    if (!isSuitableClinicalGeminiModel(raw)) continue;
    const id = extractModelId(raw.name);
    if (!deduped.has(id)) {
      deduped.set(id, {
        id,
        displayName: (raw.displayName ?? "").trim() || id,
        description: raw.description?.trim() || undefined,
      });
    }
  }

  const sorted = Array.from(deduped.values()).sort((a, b) => {
    const diff = scoreForRecommended(b.id) - scoreForRecommended(a.id);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  if (sorted.length === 0) {
    return { models: [], recommendedModel: null, fallbackModel: null };
  }

  const recommendedModel = sorted[0].id;
  const fallbackCandidates = sorted.filter((m) => m.id !== recommendedModel);
  fallbackCandidates.sort((a, b) => {
    const diff =
      scoreForFallback(b.id, recommendedModel) - scoreForFallback(a.id, recommendedModel);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  const fallbackModel = fallbackCandidates[0]?.id ?? null;

  return {
    models: sorted,
    recommendedModel,
    fallbackModel,
  };
}

export interface DiscoverModelsParams {
  manualApiKey?: string | null;
  serverApiKey?: string | null;
  listProvider?: ModelsListProvider;
  skipCache?: boolean;
  cacheTtlMs?: number;
}

interface CachedDiscoveryEntry {
  expiresAt: number;
  models: DiscoveredGeminiModel[];
  recommendedModel: string;
  fallbackModel: string | null;
  checkedAt: string;
}

const discoveryCache = new Map<string, CachedDiscoveryEntry>();
const inFlightDiscoveries = new Map<string, Promise<RawListedModel[]>>();

export function clearModelsDiscoveryCache(): void {
  discoveryCache.clear();
  inFlightDiscoveries.clear();
}

async function hashCacheKey(rawKey: string, allowlistSignature: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${rawKey}::${allowlistSignature}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Descubre modelos disponibles verificando realmente la conectividad y autenticación
 * contra la API oficial de Google. Aplica caché con TTL y deduplicación en vuelo
 * indexadas por hash SHA-256 (nunca almacena ni retorna la API Key).
 */
export async function discoverGeminiModels(
  params: DiscoverModelsParams
): Promise<ModelsDiscoveryResponse> {
  const manualKey = (params.manualApiKey ?? "").trim();
  const serverKey = (params.serverApiKey ?? "").trim();
  const hasManualKey = manualKey.length > 0;
  const hasServerKey = serverKey.length > 0;
  const effectiveKey = manualKey || serverKey;
  const keySource: ModelsDiscoveryResponse["keySource"] = hasManualKey
    ? "manual"
    : hasServerKey
      ? "server"
      : "none";
  const checkedAt = new Date().toISOString();

  if (!effectiveKey) {
    return {
      hasServerKey: false,
      hasManualKey: false,
      keySource: "none",
      authenticated: false,
      connectionStatus: "not_configured",
      models: [],
      recommendedModel: null,
      fallbackModel: null,
      checkedAt,
    };
  }

  const provider = params.listProvider ?? listAllModelsFromGoogle;
  const ttlMs = params.cacheTtlMs ?? MODELS_CACHE_TTL_MS;
  const useCache = !params.skipCache && ttlMs > 0;
  const allowlistSignature = Array.from(getAllowedGeminiModels()).sort().join(",");
  const cacheKey = useCache
    ? await hashCacheKey(effectiveKey, allowlistSignature)
    : "";

  if (useCache) {
    const cached = discoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        hasServerKey,
        hasManualKey,
        keySource,
        authenticated: true,
        connectionStatus: "connected",
        models: cached.models,
        recommendedModel: cached.recommendedModel,
        fallbackModel: cached.fallbackModel,
        checkedAt: cached.checkedAt,
      };
    }
    if (cached) {
      discoveryCache.delete(cacheKey);
    }
  }

  try {
    let rawModels: RawListedModel[];
    if (useCache) {
      let pending = inFlightDiscoveries.get(cacheKey);
      if (!pending) {
        pending = provider(effectiveKey).finally(() => {
          inFlightDiscoveries.delete(cacheKey);
        });
        inFlightDiscoveries.set(cacheKey, pending);
      }
      rawModels = await pending;
    } else {
      rawModels = await provider(effectiveKey);
    }

    const { models, recommendedModel, fallbackModel } = selectClinicalModels(rawModels);

    if (models.length === 0 || !recommendedModel) {
      return {
        hasServerKey,
        hasManualKey,
        keySource,
        authenticated: true,
        connectionStatus: "configured_disconnected",
        models: [],
        recommendedModel: null,
        fallbackModel: null,
        error:
          "La conexión se estableció, pero no se encontraron modelos permitidos disponibles para esta clave.",
        technicalDetail:
          "models.list no devolvió modelos Gemini presentes en la allowlist del servidor.",
        checkedAt,
      };
    }

    if (useCache) {
      if (discoveryCache.size >= MAX_MODELS_CACHE_ENTRIES) {
        const firstKey = discoveryCache.keys().next().value;
        if (firstKey) discoveryCache.delete(firstKey);
      }
      discoveryCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        models,
        recommendedModel,
        fallbackModel,
        checkedAt,
      });
    }

    return {
      hasServerKey,
      hasManualKey,
      keySource,
      authenticated: true,
      connectionStatus: "connected",
      models,
      recommendedModel,
      fallbackModel,
      checkedAt,
    };
  } catch (err: unknown) {
    const formatted = classifyAndFormatAiError(err);
    return {
      hasServerKey,
      hasManualKey,
      keySource,
      authenticated: false,
      connectionStatus: "configured_disconnected",
      models: [],
      recommendedModel: null,
      fallbackModel: null,
      error: formatted.userMessage,
      technicalDetail: `Error al verificar modelos (${formatted.code}, HTTP ${formatted.status}).`,
      checkedAt,
    };
  }
}
