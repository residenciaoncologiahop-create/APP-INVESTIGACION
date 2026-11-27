import { NextResponse, type NextRequest } from "next/server";
import {
  GENERIC_AUTH_UNAVAILABLE_MESSAGE,
  verifyRequestAuth,
  type AuthEnvConfig,
} from "./lib/api-security";

export async function handlePreviewMiddleware(
  request: Request,
  pathname: string,
  envOverrides?: AuthEnvConfig
): Promise<NextResponse> {
  const vercelEnv = (envOverrides?.vercelEnv ?? process.env.VERCEL_ENV ?? "")
    .trim()
    .toLowerCase();
  const hasAppPassword = Boolean(
    (envOverrides?.previewAuthPassword ?? process.env.PREVIEW_AUTH_PASSWORD ?? "").trim()
  );
  const isVercelPreview = vercelEnv === "preview";

  // En desarrollo local (o entornos no-Preview sin contraseña configurada), no bloquear /
  if (!hasAppPassword && !isVercelPreview) {
    return NextResponse.next();
  }

  const isApiRoute = pathname.startsWith("/api/");

  // En Vercel Preview, si falta la contraseña de acceso, bloquear de forma segura también /
  if (isVercelPreview && !hasAppPassword) {
    if (isApiRoute) {
      return NextResponse.json(
        {
          error: GENERIC_AUTH_UNAVAILABLE_MESSAGE,
          code: "service_unavailable",
          retryable: false,
        },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return new NextResponse(GENERIC_AUTH_UNAVAILABLE_MESSAGE, {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const auth = await verifyRequestAuth(request, envOverrides);
  if (auth.authorized) {
    return NextResponse.next();
  }

  const authHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    ...(auth.requireBasicChallenge
      ? {
          "WWW-Authenticate": 'Basic realm="OncoData Extract Preview", charset="UTF-8"',
        }
      : {}),
  };

  if (isApiRoute) {
    return NextResponse.json(
      {
        error: auth.error || "Autenticación requerida.",
        code: auth.status === 503 ? "service_unavailable" : "unauthorized",
        retryable: false,
      },
      {
        status: auth.status,
        headers: authHeaders,
      }
    );
  }

  return new NextResponse(
    auth.error || "Autenticación requerida para acceder a OncoData Extract.",
    {
      status: auth.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...authHeaders,
      },
    }
  );
}

export async function middleware(request: NextRequest) {
  return handlePreviewMiddleware(request, request.nextUrl.pathname);
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
