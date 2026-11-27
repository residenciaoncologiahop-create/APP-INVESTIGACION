import { NextResponse } from "next/server";
import { classifyAndFormatAiError } from "@/lib/ai-errors";
import {
  extractEndpointLimiter,
  getClientRateLimitKey,
  readAndParseBoundedJson,
  validateExtractPayload,
  validateJsonContentType,
  validateRequestOrigin,
  verifyRequestAuth,
} from "@/lib/api-security";
import { executeClinicalExtraction } from "@/lib/extract-service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Origin, Authorization",
} as const;

export async function POST(request: Request) {
  let releaseConcurrency: (() => void) | null = null;

  try {
    // 1. Autenticación / autorización
    const auth = await verifyRequestAuth(request);
    if (!auth.authorized) {
      return NextResponse.json(
        {
          error: auth.error || "Autenticación requerida.",
          code: "unauthorized",
          retryable: false,
        },
        {
          status: auth.status,
          headers: {
            ...NO_STORE_HEADERS,
            ...(auth.requireBasicChallenge
              ? {
                  "WWW-Authenticate":
                    'Basic realm="OncoData Extract Preview", charset="UTF-8"',
                }
              : {}),
          },
        }
      );
    }

    // 2. Validación de origen (bloqueo de invocaciones cross-site desde navegadores)
    const originCheck = validateRequestOrigin(request);
    if (!originCheck.ok) {
      return NextResponse.json(
        {
          error: originCheck.error || "Origen no permitido.",
          code: "forbidden_origin",
          retryable: false,
        },
        { status: originCheck.status, headers: NO_STORE_HEADERS }
      );
    }

    // 3. Validación estricta de Content-Type
    const contentTypeCheck = validateJsonContentType(request);
    if (!contentTypeCheck.ok) {
      return NextResponse.json(
        {
          error: contentTypeCheck.error,
          code: "unsupported_media_type",
          retryable: false,
        },
        { status: contentTypeCheck.status, headers: NO_STORE_HEADERS }
      );
    }

    // 4. Rate limiting por cliente en instancia serverless
    const clientKey = getClientRateLimitKey(request, auth.principal);
    const rate = extractEndpointLimiter.checkRateLimit(clientKey);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error:
            "Se alcanzó el límite temporal de solicitudes de extracción. Esperá unos segundos e intentá nuevamente.",
          code: "rate_limit",
          retryable: true,
        },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": String(rate.retryAfterSec),
          },
        }
      );
    }

    // 5. Lectura acotada en bytes y parseo JSON seguro
    const parsed = await readAndParseBoundedJson(request);
    if (!parsed.ok) {
      return NextResponse.json(
        {
          error: parsed.error,
          code: parsed.status === 413 ? "payload_too_large" : "invalid_json",
          retryable: false,
        },
        { status: parsed.status, headers: NO_STORE_HEADERS }
      );
    }

    // 6. Validación estricta de estructura, tipos y límites de documentos/variables/caracteres
    const validated = validateExtractPayload(parsed.data);
    if (!validated.ok) {
      return NextResponse.json(
        {
          error: validated.error,
          code: validated.code,
          retryable: false,
        },
        { status: validated.status, headers: NO_STORE_HEADERS }
      );
    }

    // 7. Control de concurrencia por cliente e instancia
    const slot = extractEndpointLimiter.acquireConcurrency(clientKey);
    if (!slot.allowed) {
      return NextResponse.json(
        {
          error:
            "Hay demasiadas extracciones en curso en simultáneo. Esperá unos segundos e intentá nuevamente.",
          code: "concurrency_limit",
          retryable: true,
        },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": "5",
          },
        }
      );
    }
    releaseConcurrency = slot.release;

    const result = await executeClinicalExtraction(validated.body);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: NO_STORE_HEADERS,
    });
  } catch (err: unknown) {
    const formatted = classifyAndFormatAiError(err);
    return NextResponse.json(
      {
        error: formatted.userMessage,
        technicalDetail: `Error interno de extracción (${formatted.code}, HTTP ${formatted.status}).`,
        code: formatted.code,
        retryable: formatted.retryable,
      },
      { status: formatted.status, headers: NO_STORE_HEADERS }
    );
  } finally {
    if (releaseConcurrency) {
      releaseConcurrency();
    }
  }
}
