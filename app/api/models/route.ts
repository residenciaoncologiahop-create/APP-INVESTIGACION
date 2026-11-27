import { NextResponse } from "next/server";
import {
  getClientRateLimitKey,
  modelsEndpointLimiter,
  validateRequestOrigin,
  verifyRequestAuth,
} from "@/lib/api-security";
import { discoverGeminiModels } from "@/lib/gemini-models";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Origin, Authorization",
} as const;

export async function GET(request: Request) {
  let releaseConcurrency: (() => void) | null = null;

  try {
    // 1. Autenticación / autorización
    const auth = await verifyRequestAuth(request);
    if (!auth.authorized) {
      return NextResponse.json(
        {
          error: auth.error || "Autenticación requerida.",
          code: "unauthorized",
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

    // 2. Validación de origen
    const originCheck = validateRequestOrigin(request);
    if (!originCheck.ok) {
      return NextResponse.json(
        {
          error: originCheck.error || "Origen no permitido.",
          code: "forbidden_origin",
        },
        { status: originCheck.status, headers: NO_STORE_HEADERS }
      );
    }

    // 3. Rate limiting en instancia serverless
    const clientKey = getClientRateLimitKey(request, auth.principal);
    const rate = modelsEndpointLimiter.checkRateLimit(clientKey);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error:
            "Se alcanzó el límite temporal de consultas de modelos. Esperá unos segundos e intentá nuevamente.",
          code: "rate_limit",
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

    // 4. Validación del header de clave manual (si existe)
    const manualApiKey = request.headers.get("x-gemini-api-key")?.trim() || "";
    if (manualApiKey.length > 256) {
      return NextResponse.json(
        {
          error: "El formato de la clave de acceso es inválido.",
          code: "invalid_api_key",
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // 5. Control de concurrencia
    const slot = modelsEndpointLimiter.acquireConcurrency(clientKey);
    if (!slot.allowed) {
      return NextResponse.json(
        {
          error: "Hay demasiadas verificaciones de modelos en curso. Intentá nuevamente.",
          code: "concurrency_limit",
        },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            "Retry-After": "3",
          },
        }
      );
    }
    releaseConcurrency = slot.release;

    const serverApiKey = process.env.GEMINI_API_KEY?.trim() || "";
    const result = await discoverGeminiModels({
      manualApiKey,
      serverApiKey,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  } catch {
    return NextResponse.json(
      {
        error: "No se pudo consultar la lista de modelos en este momento.",
        code: "models_error",
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  } finally {
    if (releaseConcurrency) {
      releaseConcurrency();
    }
  }
}
