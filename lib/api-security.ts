import type { ExtractRequestBody } from "./extract-service";
import type { DocumentCategory, VariableType } from "./types";

export const MAX_EXTRACT_BODY_BYTES = 2 * 1024 * 1024; // 2 MB (< 4.5 MB límite de Vercel)
export const MAX_EXTRACT_VARIABLES = 80;
export const MAX_EXTRACT_DOCUMENTS = 25;
export const MAX_EXTRACT_DOC_CHARS = 250_000;
export const MAX_EXTRACT_TOTAL_CHARS = 500_000;
export const MAX_STUDY_NAME_CHARS = 200;
export const MAX_VARIABLE_INSTRUCTION_CHARS = 1500;
export const MAX_VARIABLE_OPTIONS = 100;
export const MAX_VARIABLE_OPTION_CHARS = 150;

const VALID_VARIABLE_TYPES = new Set<VariableType>([
  "numeric",
  "date",
  "categorical_single",
  "categorical_multiple",
  "boolean",
  "text",
]);

const VALID_DOCUMENT_CATEGORIES = new Set<DocumentCategory>([
  "epicrisis",
  "patologia",
  "imagenes",
  "evolucion",
  "tratamiento",
  "otro",
]);

const TECHNICAL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

export interface AuthCheckResult {
  authorized: boolean;
  status: number;
  error?: string;
  principal?: string;
  requireBasicChallenge?: boolean;
}

export const GENERIC_AUTH_UNAVAILABLE_MESSAGE =
  "Acceso no disponible temporalmente por configuración del entorno.";

export interface AuthEnvConfig {
  previewAuthUser?: string;
  previewAuthPassword?: string;
  isVercel?: boolean;
  vercelEnv?: string;
  vercelProtectionConfirmed?: boolean;
}

function getAuthEnvConfig(overrides?: AuthEnvConfig): Required<AuthEnvConfig> {
  const vercelEnv = (
    overrides?.vercelEnv ??
    process.env.VERCEL_ENV ??
    ""
  )
    .trim()
    .toLowerCase();

  return {
    previewAuthUser: (
      overrides?.previewAuthUser ??
      process.env.PREVIEW_AUTH_USER ??
      "researcher"
    ).trim() || "researcher",
    previewAuthPassword: (
      overrides?.previewAuthPassword ??
      process.env.PREVIEW_AUTH_PASSWORD ??
      ""
    ).trim(),
    isVercel:
      overrides?.isVercel ??
      (process.env.VERCEL === "1" || Boolean(vercelEnv)),
    vercelEnv,
    vercelProtectionConfirmed:
      overrides?.vercelProtectionConfirmed ??
      process.env.VERCEL_DEPLOYMENT_PROTECTION_CONFIRMED === "true",
  };
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/**
 * Comparación en tiempo constante usando digest SHA-256 para evitar fugas por longitud o timing.
 * Compatible con Edge Runtime (middleware) y Node.js Runtime (route handlers).
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  if (hashA.length !== hashB.length) return false;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

function decodeBasicCredentials(encoded: string): { user: string; pass: string } | null {
  try {
    const decoded = atob(encoded.trim());
    const sepIdx = decoded.indexOf(":");
    if (sepIdx === -1) return null;
    return {
      user: decoded.slice(0, sepIdx),
      pass: decoded.slice(sepIdx + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Verifica autorización de acceso para Preview / APIs:
 * 1. Si PREVIEW_AUTH_PASSWORD está configurada: exige Basic Auth o Bearer/x-preview-access-token válido.
 * 2. En Vercel Preview (VERCEL_ENV === "preview") sin contraseña: falla cerrado (503) con mensaje genérico.
 * 3. En otros entornos de Vercel sin contraseña ni protección confirmada: falla cerrado (503) con mensaje genérico.
 * 4. En desarrollo local sin contraseña: permite el flujo local.
 */
export async function verifyRequestAuth(
  request: Request,
  envOverrides?: AuthEnvConfig
): Promise<AuthCheckResult> {
  const cfg = getAuthEnvConfig(envOverrides);

  if (cfg.previewAuthPassword) {
    const authHeader = request.headers.get("authorization") || "";
    const tokenHeader = request.headers.get("x-preview-access-token")?.trim() || "";

    if (authHeader.toLowerCase().startsWith("basic ")) {
      const creds = decodeBasicCredentials(authHeader.slice(6));
      if (creds) {
        const [userOk, passOk] = await Promise.all([
          constantTimeEquals(creds.user, cfg.previewAuthUser),
          constantTimeEquals(creds.pass, cfg.previewAuthPassword),
        ]);
        if (userOk && passOk) {
          return {
            authorized: true,
            status: 200,
            principal: `basic:${cfg.previewAuthUser}`,
          };
        }
      }
    }

    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const bearer = authHeader.slice(7).trim();
      if (bearer && (await constantTimeEquals(bearer, cfg.previewAuthPassword))) {
        return {
          authorized: true,
          status: 200,
          principal: "bearer:preview",
        };
      }
    }

    if (tokenHeader && (await constantTimeEquals(tokenHeader, cfg.previewAuthPassword))) {
      return {
        authorized: true,
        status: 200,
        principal: "token:preview",
      };
    }

    return {
      authorized: false,
      status: 401,
      error: "Autenticación requerida para acceder a este entorno.",
      requireBasicChallenge: true,
    };
  }

  // En Vercel Preview la contraseña de acceso es obligatoria; fallar cerrado con mensaje genérico
  if (cfg.vercelEnv === "preview") {
    return {
      authorized: false,
      status: 503,
      error: GENERIC_AUTH_UNAVAILABLE_MESSAGE,
    };
  }

  // En otros entornos de Vercel sin contraseña: fallar cerrado salvo protección confirmada
  if (cfg.isVercel && !cfg.vercelProtectionConfirmed) {
    return {
      authorized: false,
      status: 503,
      error: GENERIC_AUTH_UNAVAILABLE_MESSAGE,
    };
  }

  return {
    authorized: true,
    status: 200,
    principal: cfg.isVercel ? "vercel-protected" : "local-dev",
  };
}

function normalizeHost(raw: string | null): string {
  if (!raw) return "";
  return raw.split(",")[0].trim().toLowerCase();
}

function parseAllowedOrigins(rawEnv?: string): Set<string> {
  const source = rawEnv ?? process.env.ALLOWED_ORIGINS ?? "";
  const set = new Set<string>();
  for (const part of source.split(",")) {
    const trimmed = part.trim().toLowerCase().replace(/\/+$/, "");
    if (trimmed) set.add(trimmed);
  }
  return set;
}

export function validateRequestOrigin(
  request: Request,
  options?: { allowedOriginsEnv?: string }
): { ok: boolean; status: number; error?: string } {
  const secFetchSite = (request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return {
      ok: false,
      status: 403,
      error: "Solicitud rechazada: origen externo no permitido.",
    };
  }

  const allowedOrigins = parseAllowedOrigins(options?.allowedOriginsEnv);
  const requestHost =
    normalizeHost(request.headers.get("x-forwarded-host")) ||
    normalizeHost(request.headers.get("host"));

  const originHeader = request.headers.get("origin")?.trim() || "";
  if (originHeader) {
    if (originHeader.toLowerCase() === "null") {
      return {
        ok: false,
        status: 403,
        error: "Solicitud rechazada: origen inválido.",
      };
    }
    try {
      const originUrl = new URL(originHeader);
      const normalizedOrigin = originUrl.origin.toLowerCase();
      const originHost = originUrl.host.toLowerCase();
      const matchesHost = Boolean(requestHost && originHost === requestHost);
      const matchesAllowlist = allowedOrigins.has(normalizedOrigin);

      if (!matchesHost && !matchesAllowlist) {
        return {
          ok: false,
          status: 403,
          error: "Solicitud rechazada: origen externo no permitido.",
        };
      }
    } catch {
      return {
        ok: false,
        status: 403,
        error: "Solicitud rechazada: encabezado Origin malformado.",
      };
    }
  } else if (request.method === "POST") {
    const refererHeader = request.headers.get("referer")?.trim() || "";
    if (refererHeader) {
      try {
        const refUrl = new URL(refererHeader);
        const normalizedRefOrigin = refUrl.origin.toLowerCase();
        const refHost = refUrl.host.toLowerCase();
        const matchesHost = Boolean(requestHost && refHost === requestHost);
        const matchesAllowlist = allowedOrigins.has(normalizedRefOrigin);
        if (!matchesHost && !matchesAllowlist) {
          return {
            ok: false,
            status: 403,
            error: "Solicitud rechazada: Referer externo no permitido.",
          };
        }
      } catch {
        return {
          ok: false,
          status: 403,
          error: "Solicitud rechazada: encabezado Referer malformado.",
        };
      }
    }
  }

  return { ok: true, status: 200 };
}

export function validateJsonContentType(request: Request): {
  ok: boolean;
  status: number;
  error?: string;
} {
  const contentType = (request.headers.get("content-type") || "").trim().toLowerCase();
  const mediaType = contentType.split(";")[0].trim();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      status: 415,
      error: "Tipo de contenido no soportado. Se requiere application/json.",
    };
  }
  return { ok: true, status: 200 };
}

export async function readAndParseBoundedJson(
  request: Request,
  maxBytes = MAX_EXTRACT_BODY_BYTES
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string }
> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `La solicitud supera el tamaño máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`,
      };
    }
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      error: "No se pudo leer el cuerpo de la solicitud.",
    };
  }

  const byteLength = new TextEncoder().encode(rawText).byteLength;
  if (byteLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `La solicitud supera el tamaño máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB).`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(rawText);
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      status: 400,
      error: "El cuerpo de la solicitud no es un JSON válido.",
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExtractPayload(
  raw: unknown
):
  | { ok: true; body: ExtractRequestBody }
  | { ok: false; status: number; error: string; code: string } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      status: 400,
      error: "El cuerpo de la solicitud debe ser un objeto JSON válido.",
      code: "invalid_payload",
    };
  }

  if (
    raw.studyName !== undefined &&
    (typeof raw.studyName !== "string" || raw.studyName.length > MAX_STUDY_NAME_CHARS)
  ) {
    return {
      ok: false,
      status: 400,
      error: `El nombre del estudio es inválido o supera ${MAX_STUDY_NAME_CHARS} caracteres.`,
      code: "invalid_payload",
    };
  }

  if (
    raw.model !== undefined &&
    (typeof raw.model !== "string" || raw.model.length > 100)
  ) {
    return {
      ok: false,
      status: 400,
      error: "El parámetro de modelo es inválido.",
      code: "invalid_payload",
    };
  }

  if (
    raw.apiKey !== undefined &&
    (typeof raw.apiKey !== "string" || raw.apiKey.length > 256)
  ) {
    return {
      ok: false,
      status: 400,
      error: "El formato de la clave de acceso es inválido.",
      code: "invalid_payload",
    };
  }

  if (raw.forceMock !== undefined && typeof raw.forceMock !== "boolean") {
    return {
      ok: false,
      status: 400,
      error: "El parámetro forceMock debe ser booleano.",
      code: "invalid_payload",
    };
  }

  if (
    raw.redactionEnabled !== undefined &&
    typeof raw.redactionEnabled !== "boolean"
  ) {
    return {
      ok: false,
      status: 400,
      error: "El parámetro redactionEnabled debe ser booleano.",
      code: "invalid_payload",
    };
  }

  if (
    raw.redactionConfirmed !== undefined &&
    typeof raw.redactionConfirmed !== "boolean"
  ) {
    return {
      ok: false,
      status: 400,
      error: "El parámetro redactionConfirmed debe ser booleano.",
      code: "invalid_payload",
    };
  }

  if (!Array.isArray(raw.variables) || raw.variables.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Definí al menos una variable del estudio antes de iniciar la extracción.",
      code: "invalid_payload",
    };
  }

  if (raw.variables.length > MAX_EXTRACT_VARIABLES) {
    return {
      ok: false,
      status: 413,
      error: `Se superó el máximo permitido de ${MAX_EXTRACT_VARIABLES} variables por solicitud.`,
      code: "payload_too_large",
    };
  }

  for (const item of raw.variables) {
    if (!isPlainObject(item)) {
      return {
        ok: false,
        status: 400,
        error: "Todas las variables deben ser objetos válidos.",
        code: "invalid_payload",
      };
    }
    if (
      typeof item.technicalName !== "string" ||
      !TECHNICAL_NAME_REGEX.test(item.technicalName)
    ) {
      return {
        ok: false,
        status: 400,
        error: "Alguna variable contiene un nombre técnico inválido.",
        code: "invalid_payload",
      };
    }
    if (typeof item.label !== "string" || item.label.length > 200) {
      return {
        ok: false,
        status: 400,
        error: "Alguna variable contiene una etiqueta inválida.",
        code: "invalid_payload",
      };
    }
    if (
      typeof item.type !== "string" ||
      !VALID_VARIABLE_TYPES.has(item.type as VariableType)
    ) {
      return {
        ok: false,
        status: 400,
        error: "Alguna variable especifica un tipo de dato no soportado.",
        code: "invalid_payload",
      };
    }
    if (
      !Array.isArray(item.options) ||
      item.options.length > MAX_VARIABLE_OPTIONS ||
      item.options.some(
        (opt) => typeof opt !== "string" || opt.length > MAX_VARIABLE_OPTION_CHARS
      )
    ) {
      return {
        ok: false,
        status: 400,
        error: "Las opciones de una variable son inválidas o superan el límite permitido.",
        code: "invalid_payload",
      };
    }
    if (
      typeof item.aiInstruction !== "string" ||
      item.aiInstruction.length > MAX_VARIABLE_INSTRUCTION_CHARS
    ) {
      return {
        ok: false,
        status: 400,
        error: `La instrucción de una variable supera el máximo de ${MAX_VARIABLE_INSTRUCTION_CHARS} caracteres.`,
        code: "invalid_payload",
      };
    }
    if (
      item.missingValue !== undefined &&
      (typeof item.missingValue !== "string" || item.missingValue.length > 50)
    ) {
      return {
        ok: false,
        status: 400,
        error: "El valor de dato faltante de una variable es inválido.",
        code: "invalid_payload",
      };
    }
    if (
      item.unit !== undefined &&
      (typeof item.unit !== "string" || item.unit.length > 50)
    ) {
      return {
        ok: false,
        status: 400,
        error: "La unidad de una variable es inválida.",
        code: "invalid_payload",
      };
    }
  }

  if (!Array.isArray(raw.documents) || raw.documents.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Este paciente no tiene historias clínicas cargadas.",
      code: "invalid_payload",
    };
  }

  if (raw.documents.length > MAX_EXTRACT_DOCUMENTS) {
    return {
      ok: false,
      status: 413,
      error: `Se superó el máximo permitido de ${MAX_EXTRACT_DOCUMENTS} documentos por solicitud.`,
      code: "payload_too_large",
    };
  }

  let totalChars = 0;
  for (const doc of raw.documents) {
    if (!isPlainObject(doc)) {
      return {
        ok: false,
        status: 400,
        error: "Todos los documentos deben ser objetos válidos.",
        code: "invalid_payload",
      };
    }
    if (typeof doc.id !== "string" || !doc.id.trim() || doc.id.length > 100) {
      return {
        ok: false,
        status: 400,
        error: "Algún documento tiene un identificador inválido.",
        code: "invalid_payload",
      };
    }
    if (typeof doc.filename !== "string" || doc.filename.length > 255) {
      return {
        ok: false,
        status: 400,
        error: "Algún documento tiene un nombre de archivo inválido.",
        code: "invalid_payload",
      };
    }
    if (
      typeof doc.category !== "string" ||
      !VALID_DOCUMENT_CATEGORIES.has(doc.category as DocumentCategory)
    ) {
      return {
        ok: false,
        status: 400,
        error: "Algún documento tiene una categoría no permitida.",
        code: "invalid_payload",
      };
    }
    if (typeof doc.redactionConfirmed !== "boolean") {
      return {
        ok: false,
        status: 400,
        error: "Cada documento debe informar explícitamente redactionConfirmed.",
        code: "redaction_unconfirmed",
      };
    }
    if (typeof doc.redactedText !== "string") {
      return {
        ok: false,
        status: 422,
        error: "Cada documento debe incluir explícitamente el campo redactedText.",
        code: "missing_redacted_text",
      };
    }
    if (doc.redactedText.length > MAX_EXTRACT_DOC_CHARS) {
      return {
        ok: false,
        status: 413,
        error: `Un documento supera el límite máximo de ${MAX_EXTRACT_DOC_CHARS} caracteres.`,
        code: "payload_too_large",
      };
    }
    totalChars += doc.redactedText.length;
    if (totalChars > MAX_EXTRACT_TOTAL_CHARS) {
      return {
        ok: false,
        status: 413,
        error: `El texto acumulado supera el límite máximo de ${MAX_EXTRACT_TOTAL_CHARS} caracteres por solicitud.`,
        code: "payload_too_large",
      };
    }
  }

  return {
    ok: true,
    body: raw as unknown as ExtractRequestBody,
  };
}

export function getClientRateLimitKey(request: Request, principal?: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const ip =
    (forwarded ? forwarded.split(",")[0].trim() : "") ||
    (realIp ? realIp.trim() : "") ||
    "unknown-ip";
  return `${principal || "anon"}::${ip}`;
}

/**
 * Limitador de frecuencia (ventana deslizante) y concurrencia por instancia serverless.
 * Nota: en Vercel Serverless opera a nivel de instancia caliente (Fluid Compute);
 * para límites globales entre múltiples instancias se complementa con Vercel WAF.
 */
export class InstanceRateAndConcurrencyLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly activeByKey = new Map<string, number>();
  private totalActive = 0;

  constructor(
    private readonly config: {
      windowMs: number;
      maxRequestsPerWindow: number;
      maxConcurrentPerKey?: number;
      maxTotalConcurrent?: number;
      maxTrackedKeys?: number;
    }
  ) {}

  checkRateLimit(
    key: string,
    now = Date.now()
  ): { allowed: boolean; retryAfterSec: number } {
    const cutoff = now - this.config.windowMs;
    const prev = this.windows.get(key) || [];
    const recent = prev.filter((ts) => ts > cutoff);

    if (recent.length >= this.config.maxRequestsPerWindow) {
      const oldestInWindow = recent[0];
      const retryAfterMs = Math.max(1000, oldestInWindow + this.config.windowMs - now);
      this.windows.set(key, recent);
      return {
        allowed: false,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      };
    }

    recent.push(now);
    this.windows.set(key, recent);

    const maxKeys = this.config.maxTrackedKeys ?? 500;
    if (this.windows.size > maxKeys) {
      for (const [k, timestamps] of this.windows.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          this.windows.delete(k);
        }
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  acquireConcurrency(key: string): { allowed: boolean; release: () => void } {
    const perKeyLimit = this.config.maxConcurrentPerKey ?? Infinity;
    const totalLimit = this.config.maxTotalConcurrent ?? Infinity;
    const currentForKey = this.activeByKey.get(key) || 0;

    if (currentForKey >= perKeyLimit || this.totalActive >= totalLimit) {
      return { allowed: false, release: () => {} };
    }

    this.activeByKey.set(key, currentForKey + 1);
    this.totalActive += 1;

    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.totalActive = Math.max(0, this.totalActive - 1);
        const curr = this.activeByKey.get(key) || 0;
        if (curr <= 1) {
          this.activeByKey.delete(key);
        } else {
          this.activeByKey.set(key, curr - 1);
        }
      },
    };
  }

  reset(): void {
    this.windows.clear();
    this.activeByKey.clear();
    this.totalActive = 0;
  }
}

export const extractEndpointLimiter = new InstanceRateAndConcurrencyLimiter({
  windowMs: 60_000,
  maxRequestsPerWindow: 20,
  maxConcurrentPerKey: 2,
  maxTotalConcurrent: 4,
});

export const modelsEndpointLimiter = new InstanceRateAndConcurrencyLimiter({
  windowMs: 60_000,
  maxRequestsPerWindow: 15,
  maxConcurrentPerKey: 2,
  maxTotalConcurrent: 6,
});
