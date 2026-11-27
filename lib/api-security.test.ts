import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handlePreviewMiddleware } from "../middleware";
import {
  GENERIC_AUTH_UNAVAILABLE_MESSAGE,
  InstanceRateAndConcurrencyLimiter,
  MAX_EXTRACT_DOCUMENTS,
  MAX_EXTRACT_DOC_CHARS,
  MAX_EXTRACT_TOTAL_CHARS,
  MAX_EXTRACT_VARIABLES,
  readAndParseBoundedJson,
  validateExtractPayload,
  validateJsonContentType,
  validateRequestOrigin,
  verifyRequestAuth,
} from "./api-security";
import {
  clearModelsDiscoveryCache,
  discoverGeminiModels,
  isAllowedGeminiModelId,
  selectClinicalModels,
} from "./gemini-models";
import { executeClinicalExtraction } from "./extract-service";
import type { StudyVariable } from "./types";

const NOW = "2026-11-27T12:00:00.000Z";

function makeValidVariable(idx = 0): StudyVariable {
  return {
    id: `var-${idx}`,
    studyId: "study-sec",
    technicalName: `var_clinica_${idx}`,
    label: `Variable clínica ${idx}`,
    section: "demografia",
    type: "numeric",
    options: [],
    aiInstruction: "Extraer valor numérico explícito.",
    missingValue: "NR",
    unit: "años",
    order: idx,
    createdAt: NOW,
  };
}

function makeValidExtractBody() {
  return {
    studyName: "Estudio Demo Seguridad",
    model: "gemini-2.5-flash",
    redactionEnabled: true,
    redactionConfirmed: true,
    variables: [makeValidVariable(0)],
    documents: [
      {
        id: "doc-1",
        filename: "DOC-01",
        category: "epicrisis",
        redactedText:
          "Paciente [REDACTADO] de 64 años con diagnóstico histológico confirmado de adenocarcinoma pulmonar.",
        redactionConfirmed: true,
      },
    ],
  };
}

describe("Autenticación y autorización para Preview (verifyRequestAuth)", () => {
  it("rechaza solicitudes sin credenciales o con credenciales inválidas cuando PREVIEW_AUTH_PASSWORD está activa", async () => {
    const reqNoAuth = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
    });
    const res1 = await verifyRequestAuth(reqNoAuth, {
      previewAuthUser: "researcher",
      previewAuthPassword: "SuperSecretPreviewPassword123!",
      isVercel: true,
    });
    assert.equal(res1.authorized, false);
    assert.equal(res1.status, 401);
    assert.equal(res1.requireBasicChallenge, true);

    const wrongBasic = `Basic ${btoa("researcher:wrong-pass")}`;
    const reqWrong = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { Authorization: wrongBasic },
    });
    const res2 = await verifyRequestAuth(reqWrong, {
      previewAuthUser: "researcher",
      previewAuthPassword: "SuperSecretPreviewPassword123!",
      isVercel: true,
    });
    assert.equal(res2.authorized, false);
    assert.equal(res2.status, 401);
  });

  it("acepta Basic Auth, Bearer y x-preview-access-token válidos", async () => {
    const pass = "SuperSecretPreviewPassword123!";
    const basicReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`researcher:${pass}`)}` },
    });
    const rBasic = await verifyRequestAuth(basicReq, {
      previewAuthUser: "researcher",
      previewAuthPassword: pass,
      isVercel: true,
    });
    assert.equal(rBasic.authorized, true);

    const bearerReq = new Request("https://preview.vercel.app/api/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${pass}` },
    });
    const rBearer = await verifyRequestAuth(bearerReq, {
      previewAuthUser: "researcher",
      previewAuthPassword: pass,
      isVercel: true,
    });
    assert.equal(rBearer.authorized, true);

    const tokenReq = new Request("https://preview.vercel.app/api/models", {
      method: "GET",
      headers: { "x-preview-access-token": pass },
    });
    const rToken = await verifyRequestAuth(tokenReq, {
      previewAuthUser: "researcher",
      previewAuthPassword: pass,
      isVercel: true,
    });
    assert.equal(rToken.authorized, true);
  });

  it("falla cerrado (503) sin exponer nombres de variables internas cuando falta configuración en Vercel", async () => {
    const req = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
    });

    // Vercel Preview sin PREVIEW_AUTH_PASSWORD (incluso aunque vercelProtectionConfirmed sea true)
    const blockedPreview = await verifyRequestAuth(req, {
      previewAuthPassword: "",
      isVercel: true,
      vercelEnv: "preview",
      vercelProtectionConfirmed: true,
    });
    assert.equal(blockedPreview.authorized, false);
    assert.equal(blockedPreview.status, 503);
    assert.equal(blockedPreview.error, GENERIC_AUTH_UNAVAILABLE_MESSAGE);
    assert.equal(blockedPreview.error?.includes("PREVIEW_AUTH_PASSWORD"), false);
    assert.equal(
      blockedPreview.error?.includes("VERCEL_DEPLOYMENT_PROTECTION_CONFIRMED"),
      false
    );

    // Otro entorno de Vercel sin contraseña ni protección confirmada
    const blockedOtherVercel = await verifyRequestAuth(req, {
      previewAuthPassword: "",
      isVercel: true,
      vercelEnv: "production",
      vercelProtectionConfirmed: false,
    });
    assert.equal(blockedOtherVercel.authorized, false);
    assert.equal(blockedOtherVercel.status, 503);
    assert.equal(blockedOtherVercel.error?.includes("PREVIEW_AUTH_PASSWORD"), false);
    assert.equal(
      blockedOtherVercel.error?.includes("VERCEL_DEPLOYMENT_PROTECTION_CONFIRMED"),
      false
    );

    // Producción con protección confirmada
    const allowedWithProtection = await verifyRequestAuth(req, {
      previewAuthPassword: "",
      isVercel: true,
      vercelEnv: "production",
      vercelProtectionConfirmed: true,
    });
    assert.equal(allowedWithProtection.authorized, true);

    // Desarrollo local sin contraseña: no se bloquea
    const allowedLocal = await verifyRequestAuth(req, {
      previewAuthPassword: "",
      isVercel: false,
      vercelEnv: "",
      vercelProtectionConfirmed: false,
    });
    assert.equal(allowedLocal.authorized, true);
    assert.equal(allowedLocal.principal, "local-dev");
  });
});

describe("Middleware de Preview (middleware.ts)", () => {
  it("en Vercel Preview sin PREVIEW_AUTH_PASSWORD bloquea / y /api/* con respuesta genérica sin nombres de variables", async () => {
    const rootReq = new Request("https://preview.vercel.app/", { method: "GET" });
    const rootRes = await handlePreviewMiddleware(rootReq, "/", {
      vercelEnv: "preview",
      isVercel: true,
      previewAuthPassword: "",
    });
    assert.equal(rootRes.status, 503);
    const rootBody = await rootRes.text();
    assert.equal(rootBody, GENERIC_AUTH_UNAVAILABLE_MESSAGE);
    assert.equal(rootBody.includes("PREVIEW_AUTH_PASSWORD"), false);
    assert.equal(rootBody.includes("VERCEL_"), false);

    const apiReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
    });
    const apiRes = await handlePreviewMiddleware(apiReq, "/api/extract", {
      vercelEnv: "preview",
      isVercel: true,
      previewAuthPassword: "",
    });
    assert.equal(apiRes.status, 503);
    const apiBody = await apiRes.text();
    assert.equal(apiBody.includes("PREVIEW_AUTH_PASSWORD"), false);
    assert.equal(apiBody.includes("VERCEL_"), false);
  });

  it("en Vercel Preview con contraseña configurada exige Basic Auth en / y permite credenciales válidas", async () => {
    const pass = "PreviewSecret2026!";

    const unauthReq = new Request("https://preview.vercel.app/", { method: "GET" });
    const unauthRes = await handlePreviewMiddleware(unauthReq, "/", {
      vercelEnv: "preview",
      isVercel: true,
      previewAuthUser: "researcher",
      previewAuthPassword: pass,
    });
    assert.equal(unauthRes.status, 401);
    assert.match(unauthRes.headers.get("www-authenticate") || "", /^Basic realm=/i);

    const validReq = new Request("https://preview.vercel.app/", {
      method: "GET",
      headers: { Authorization: `Basic ${btoa(`researcher:${pass}`)}` },
    });
    const validRes = await handlePreviewMiddleware(validReq, "/", {
      vercelEnv: "preview",
      isVercel: true,
      previewAuthUser: "researcher",
      previewAuthPassword: pass,
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.headers.get("x-middleware-next"), "1");
  });

  it("en desarrollo local sin contraseña no bloquea /", async () => {
    const localReq = new Request("http://localhost:3000/", { method: "GET" });
    const localRes = await handlePreviewMiddleware(localReq, "/", {
      vercelEnv: "",
      isVercel: false,
      previewAuthPassword: "",
    });
    assert.equal(localRes.status, 200);
    assert.equal(localRes.headers.get("x-middleware-next"), "1");
  });
});

describe("Validación de origen y Content-Type", () => {
  it("rechaza solicitudes cross-site y orígenes externos no autorizados", () => {
    const crossSiteReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: {
        host: "preview.vercel.app",
        "sec-fetch-site": "cross-site",
      },
    });
    const r1 = validateRequestOrigin(crossSiteReq);
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 403);

    const evilOriginReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: {
        host: "preview.vercel.app",
        origin: "https://attacker.example",
      },
    });
    const r2 = validateRequestOrigin(evilOriginReq);
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 403);

    const sameOriginReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: {
        host: "preview.vercel.app",
        origin: "https://preview.vercel.app",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(validateRequestOrigin(sameOriginReq).ok, true);

    const allowlistedReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: {
        host: "preview.vercel.app",
        origin: "https://trusted-alias.vercel.app",
      },
    });
    assert.equal(
      validateRequestOrigin(allowlistedReq, {
        allowedOriginsEnv: "https://trusted-alias.vercel.app",
      }).ok,
      true
    );
  });

  it("exige estrictamente Content-Type application/json (rechaza text/plain y ausente)", () => {
    const plainReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    const r1 = validateJsonContentType(plainReq);
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 415);

    const jsonReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{}",
    });
    assert.equal(validateJsonContentType(jsonReq).ok, true);
  });
});

describe("Límites de tamaño y validación estricta de payload", () => {
  it("rechaza cuerpos que superan el límite en bytes (413) y JSON malformado sin filtrar contenido", async () => {
    const hugeReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "A".repeat(2048) }),
    });
    const tooLarge = await readAndParseBoundedJson(hugeReq, 1024);
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) assert.equal(tooLarge.status, 413);

    const badJsonReq = new Request("https://preview.vercel.app/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"dato":"SECRETO_NO_EXPONER_EN_ERROR"',
    });
    const malformed = await readAndParseBoundedJson(badJsonReq, 4096);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.status, 400);
      assert.equal(malformed.error.includes("SECRETO_NO_EXPONER_EN_ERROR"), false);
    }
  });

  it("valida límites de cantidad de variables, documentos y caracteres", () => {
    assert.equal(validateExtractPayload(makeValidExtractBody()).ok, true);

    const tooManyVars = makeValidExtractBody();
    tooManyVars.variables = Array.from(
      { length: MAX_EXTRACT_VARIABLES + 1 },
      (_, i) => makeValidVariable(i)
    );
    const rVars = validateExtractPayload(tooManyVars);
    assert.equal(rVars.ok, false);
    if (!rVars.ok) assert.equal(rVars.status, 413);

    const tooManyDocs = makeValidExtractBody();
    tooManyDocs.documents = Array.from(
      { length: MAX_EXTRACT_DOCUMENTS + 1 },
      (_, i) => ({
        id: `d-${i}`,
        filename: `DOC-${String(i + 1).padStart(2, "0")}`,
        category: "epicrisis",
        redactedText: "Texto redactado válido con más de treinta caracteres de prueba.",
        redactionConfirmed: true,
      })
    );
    const rDocs = validateExtractPayload(tooManyDocs);
    assert.equal(rDocs.ok, false);
    if (!rDocs.ok) assert.equal(rDocs.status, 413);

    const docTooLong = makeValidExtractBody();
    docTooLong.documents[0].redactedText = "X".repeat(MAX_EXTRACT_DOC_CHARS + 1);
    const rDocChars = validateExtractPayload(docTooLong);
    assert.equal(rDocChars.ok, false);
    if (!rDocChars.ok) assert.equal(rDocChars.status, 413);

    const totalTooLong = makeValidExtractBody();
    totalTooLong.documents = [
      {
        id: "d1",
        filename: "DOC-01",
        category: "epicrisis",
        redactedText: "A".repeat(200_000),
        redactionConfirmed: true,
      },
      {
        id: "d2",
        filename: "DOC-02",
        category: "evolucion",
        redactedText: "B".repeat(200_000),
        redactionConfirmed: true,
      },
      {
        id: "d3",
        filename: "DOC-03",
        category: "patologia",
        redactedText: "C".repeat(MAX_EXTRACT_TOTAL_CHARS - 399_999),
        redactionConfirmed: true,
      },
    ];
    const rTotalChars = validateExtractPayload(totalTooLong);
    assert.equal(rTotalChars.ok, false);
    if (!rTotalChars.ok) assert.equal(rTotalChars.status, 413);
  });

  it("rechaza tipos inválidos y categorías o nombres técnicos no permitidos", () => {
    const badVar = makeValidExtractBody();
    (badVar.variables[0] as unknown as Record<string, unknown>).type = "exec_shell";
    assert.equal(validateExtractPayload(badVar).ok, false);

    const badTechName = makeValidExtractBody();
    badTechName.variables[0].technicalName = "edad; DROP TABLE";
    assert.equal(validateExtractPayload(badTechName).ok, false);

    const badCategory = makeValidExtractBody();
    (badCategory.documents[0] as unknown as Record<string, unknown>).category =
      "categoria_invalida";
    assert.equal(validateExtractPayload(badCategory).ok, false);
  });
});

describe("Allowlist de modelos Gemini y caché de /api/models", () => {
  it("acepta modelos de la allowlist y rechaza modelos arbitrarios o no clínicos antes de invocar Gemini", async () => {
    assert.equal(isAllowedGeminiModelId("gemini-2.5-flash"), true);
    assert.equal(isAllowedGeminiModelId("gemini-2.5-pro"), true);
    assert.equal(isAllowedGeminiModelId("imagen-3.0-generate-002"), false);
    assert.equal(isAllowedGeminiModelId("gemini-2.5-flash-image"), false);
    assert.equal(isAllowedGeminiModelId("models/../../secret"), false);
    assert.equal(isAllowedGeminiModelId("gemini-99-unapproved"), false);

    let called = false;
    const res = await executeClinicalExtraction(
      {
        ...makeValidExtractBody(),
        apiKey: "test-gemini-key-placeholder",
        model: "gemini-99-unapproved",
      },
      {
        generateContent: async () => {
          called = true;
          return { text: "{}" };
        },
      }
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
    assert.equal("code" in res.body && res.body.code, "model_not_allowed");
  });

  it("filtra models.list por allowlist y aplica caché TTL + deduplicación en vuelo", async () => {
    clearModelsDiscoveryCache();
    let providerCalls = 0;

    const listProvider = async () => {
      providerCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          supportedActions: ["generateContent"],
        },
        {
          name: "models/gemini-99-unapproved",
          displayName: "Unapproved Model",
          supportedActions: ["generateContent"],
        },
        {
          name: "models/imagen-3.0",
          displayName: "Imagen 3",
          supportedActions: ["generateContent"],
        },
      ];
    };

    const selected = selectClinicalModels([
      {
        name: "models/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        supportedActions: ["generateContent"],
      },
      {
        name: "models/gemini-99-unapproved",
        displayName: "Unapproved",
        supportedActions: ["generateContent"],
      },
    ]);
    assert.deepEqual(
      selected.models.map((m) => m.id),
      ["gemini-2.5-flash"]
    );

    // Dos llamadas simultáneas deben deduplicarse en una sola consulta a Google
    const [r1, r2] = await Promise.all([
      discoverGeminiModels({
        serverApiKey: "test-server-cache-key-001",
        listProvider,
        cacheTtlMs: 60_000,
      }),
      discoverGeminiModels({
        serverApiKey: "test-server-cache-key-001",
        listProvider,
        cacheTtlMs: 60_000,
      }),
    ]);
    assert.equal(providerCalls, 1);
    assert.equal(r1.authenticated, true);
    assert.equal(r2.recommendedModel, "gemini-2.5-flash");

    // Una tercera llamada secuencial dentro del TTL debe servirse desde caché
    const r3 = await discoverGeminiModels({
      serverApiKey: "test-server-cache-key-001",
      listProvider,
      cacheTtlMs: 60_000,
    });
    assert.equal(providerCalls, 1);
    assert.equal(r3.models.length, 1);
    clearModelsDiscoveryCache();
  });
});

describe("Rate limiting, concurrencia y sanitización de errores", () => {
  it("limita solicitudes por ventana y concurrencia por cliente/instancia", () => {
    const limiter = new InstanceRateAndConcurrencyLimiter({
      windowMs: 60_000,
      maxRequestsPerWindow: 2,
      maxConcurrentPerKey: 1,
      maxTotalConcurrent: 2,
    });

    const t0 = 1_700_000_000_000;
    assert.equal(limiter.checkRateLimit("userA::1.1.1.1", t0).allowed, true);
    assert.equal(limiter.checkRateLimit("userA::1.1.1.1", t0 + 1000).allowed, true);
    const blocked = limiter.checkRateLimit("userA::1.1.1.1", t0 + 2000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec > 0);
    // Después de vencida la ventana vuelve a permitir
    assert.equal(limiter.checkRateLimit("userA::1.1.1.1", t0 + 61_000).allowed, true);

    const s1 = limiter.acquireConcurrency("userA::1.1.1.1");
    assert.equal(s1.allowed, true);
    const s2 = limiter.acquireConcurrency("userA::1.1.1.1");
    assert.equal(s2.allowed, false);
    const s3 = limiter.acquireConcurrency("userB::2.2.2.2");
    assert.equal(s3.allowed, true);
    const s4 = limiter.acquireConcurrency("userC::3.3.3.3");
    assert.equal(s4.allowed, false); // límite total = 2

    s1.release();
    const s5 = limiter.acquireConcurrency("userC::3.3.3.3");
    assert.equal(s5.allowed, true);
    s3.release();
    s5.release();
  });

  it("no expone fragmentos clínicos ni secretos en technicalDetail ante errores de parseo o del proveedor", async () => {
    const parseFail = await executeClinicalExtraction(
      {
        ...makeValidExtractBody(),
        apiKey: "test-gemini-key-placeholder",
      },
      {
        generateContent: async () => ({
          text: '{"extractions":{"var_clinica_0":{"evidence_quote":"FRAGMENTO_CLINICO_CONFIDENCIAL_NO_FILTRAR"',
        }),
      }
    );

    assert.equal(parseFail.status, 502);
    const serializedParse = JSON.stringify(parseFail.body);
    assert.equal(serializedParse.includes("FRAGMENTO_CLINICO_CONFIDENCIAL_NO_FILTRAR"), false);

    const sdkFail = await executeClinicalExtraction(
      {
        ...makeValidExtractBody(),
        apiKey: "test-gemini-key-placeholder",
      },
      {
        generateContent: async () => {
          throw new Error(
            "Internal upstream stacktrace /etc/secret test-gemini-key-placeholder"
          );
        },
      }
    );

    assert.equal(sdkFail.status, 500);
    const serializedSdk = JSON.stringify(sdkFail.body);
    assert.equal(serializedSdk.includes("test-gemini-key-placeholder"), false);
    assert.equal(serializedSdk.includes("/etc/secret"), false);
  });
});
