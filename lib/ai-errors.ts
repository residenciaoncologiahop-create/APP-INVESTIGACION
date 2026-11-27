export type AiErrorCode =
  | "auth"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "network"
  | "empty_response"
  | "parse_error"
  | "scanned_pdf"
  | "no_models"
  | "unknown";

export interface StructuredAiError {
  code: AiErrorCode;
  status: number;
  userMessage: string;
  technicalDetail: string;
  retryable: boolean;
}

/**
 * Elimina cualquier posible API Key de mensajes técnicos para que nunca
 * quede expuesta en respuestas, interfaz o registros.
 */
export function sanitizeSensitiveText(input: string): string {
  if (!input) return "";
  return input
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[CLAVE_OCULTA]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[CLAVE_OCULTA]")
    .replace(/(x-goog-api-key|x-gemini-api-key)\s*[:=]\s*[^\s,"']+/gi, "$1=[CLAVE_OCULTA]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[CLAVE_OCULTA]");
}

interface ParsedRawErrorInfo {
  status?: number;
  apiStatus?: string;
  message: string;
  rawText: string;
}

function extractRawErrorInfo(err: unknown, explicitStatus?: number): ParsedRawErrorInfo {
  let rawMessage = "";
  let status = explicitStatus;
  let apiStatus = "";

  if (typeof err === "string") {
    rawMessage = err;
  } else if (err && typeof err === "object") {
    const obj = err as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; status?: unknown; message?: unknown };
    };
    if (typeof obj.status === "number") status = obj.status;
    else if (typeof obj.statusCode === "number") status = obj.statusCode;
    else if (typeof obj.error?.code === "number") status = obj.error.code;

    if (typeof obj.error?.status === "string") apiStatus = obj.error.status;

    if (typeof obj.message === "string" && obj.message.trim()) {
      rawMessage = obj.message;
    } else if (typeof obj.error?.message === "string" && obj.error.message.trim()) {
      rawMessage = obj.error.message;
    } else {
      try {
        rawMessage = JSON.stringify(err);
      } catch {
        rawMessage = "Error desconocido";
      }
    }
  } else {
    rawMessage = "Error desconocido";
  }

  const sanitizedRaw = sanitizeSensitiveText(rawMessage).trim();

  // Muchos errores del SDK de Google incluyen JSON embebido dentro de message
  let extractedInnerMessage = sanitizedRaw;
  const jsonStart = sanitizedRaw.indexOf("{");
  const jsonEnd = sanitizedRaw.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(sanitizedRaw.slice(jsonStart, jsonEnd + 1)) as {
        error?: { code?: number; message?: string; status?: string };
        code?: number;
        message?: string;
        status?: string;
      };
      const inner = parsed.error ?? parsed;
      if (typeof inner.code === "number" && !status) {
        status = inner.code;
      }
      if (typeof inner.status === "string" && !apiStatus) {
        apiStatus = inner.status;
      }
      if (typeof inner.message === "string" && inner.message.trim()) {
        extractedInnerMessage = sanitizeSensitiveText(inner.message.trim());
      }
    } catch {
      // No es JSON válido; conservar el texto original sanitizado
    }
  }

  return {
    status,
    apiStatus,
    message: extractedInnerMessage,
    rawText: sanitizedRaw,
  };
}

/**
 * Convierte cualquier error técnico de Gemini o de red en un mensaje claro
 * en español para médicos, preservando el detalle técnico sanitizado aparte.
 */
export function classifyAndFormatAiError(
  err: unknown,
  options?: { status?: number; autoSwitchedModel?: boolean }
): StructuredAiError {
  const info = extractRawErrorInfo(err, options?.status);
  const combined = `${info.apiStatus} ${info.message} ${info.rawText}`;
  const status = info.status;

  // 1. Autenticación / clave inválida (401 / 403)
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|PERMISSION_DENIED|invalid api key|forbidden/i.test(
      combined
    )
  ) {
    return {
      code: "auth",
      status: status === 403 ? 403 : 401,
      userMessage: "La clave de acceso a la IA no es válida. Revisá la configuración.",
      technicalDetail: info.rawText || "Error de autenticación (401/403).",
      retryable: false,
    };
  }

  // 2. Modelo no encontrado / obsoleto (404)
  if (
    status === 404 ||
    /NOT_FOUND|not found for API version|models\/[^\s]+ is not found|model.*not found/i.test(
      combined
    )
  ) {
    return {
      code: "not_found",
      status: 404,
      userMessage: options?.autoSwitchedModel
        ? "El modelo seleccionado ya no está disponible; se seleccionó uno nuevo automáticamente."
        : "El modelo seleccionado ya no está disponible. El sistema buscará uno disponible automáticamente.",
      technicalDetail: info.rawText || "Modelo no encontrado (404).",
      retryable: false,
    };
  }

  // 3. Saturación / alta demanda (503)
  if (
    status === 503 ||
    /503|UNAVAILABLE|high\s*demand|overloaded|temporarily\s*unavailable|service\s*unavailable/i.test(
      combined
    )
  ) {
    return {
      code: "overloaded",
      status: 503,
      userMessage:
        "El servicio de IA está temporalmente ocupado. Intentá nuevamente en unos minutos o probá otro modelo.",
      technicalDetail: info.rawText || "Servicio temporalmente no disponible (503).",
      retryable: true,
    };
  }

  // 4. Límite de consultas / cuota (429)
  if (
    status === 429 ||
    /429|RESOURCE_EXHAUSTED|quota|rate\s*limit|too\s*many\s*requests/i.test(combined)
  ) {
    return {
      code: "rate_limit",
      status: 429,
      userMessage:
        "El servicio de IA alcanzó temporalmente su límite de consultas. Intentá nuevamente en unos minutos o probá otro modelo.",
      technicalDetail: info.rawText || "Límite de consultas excedido (429).",
      retryable: true,
    };
  }

  // 5. Error de red / conexión
  if (
    /Failed to fetch|fetch failed|NetworkError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|ERR_NETWORK|socket hang up/i.test(
      combined
    )
  ) {
    return {
      code: "network",
      status: 503,
      userMessage: "Se perdió la conexión con el servidor local de la aplicación.",
      technicalDetail: info.rawText || "Error de conexión de red.",
      retryable: true,
    };
  }

  // 6. Respuesta vacía o inválida del modelo (502)
  if (status === 502 || /parse|JSON|respuesta vacía|empty response/i.test(combined)) {
    return {
      code: "parse_error",
      status: 502,
      userMessage:
        "El servicio de IA devolvió una respuesta incompleta. Intentá analizar nuevamente este paciente.",
      technicalDetail: info.rawText || "Respuesta inválida del servicio de IA (502).",
      retryable: true,
    };
  }

  const normalizedStatus = status && status >= 400 && status < 600 ? status : 500;
  return {
    code: "unknown",
    status: normalizedStatus,
    userMessage:
      "No se pudo completar la extracción con IA en este momento. Intentá nuevamente o revisá el detalle técnico.",
    technicalDetail: info.rawText || `Error inesperado (HTTP ${normalizedStatus}).`,
    retryable: normalizedStatus >= 500,
  };
}

/**
 * Garantiza que incluso errores antiguos guardados en el navegador con JSON crudo
 * se muestren siempre en español comprensible, moviendo el original al detalle técnico.
 */
export function formatStoredErrorForDisplay(
  rawError?: string | null,
  explicitTechnicalDetail?: string | null
): { userMessage: string; technicalDetail: string | null } | null {
  if (!rawError && !explicitTechnicalDetail) return null;
  const text = (rawError ?? "").trim();
  const detail = explicitTechnicalDetail ? sanitizeSensitiveText(explicitTechnicalDetail).trim() : null;

  const looksTechnical =
    /^\s*\{.*"error"|API_KEY_INVALID|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|HTTP\s+\d{3}|Failed to fetch|fetch failed|SyntaxError|TypeError/i.test(
      text
    );

  if (looksTechnical) {
    const formatted = classifyAndFormatAiError(text);
    return {
      userMessage: formatted.userMessage,
      technicalDetail: detail || formatted.technicalDetail,
    };
  }

  return {
    userMessage: text || "No se pudo completar la extracción.",
    technicalDetail: detail,
  };
}
