import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatNeutralDocumentId,
  getMissingMinimumRedactionRules,
  hasUsableRedactedText,
  isRedactionEnabled,
  toNeutralDocumentId,
} from "./redactor";
import {
  executeClinicalExtraction,
  type ExtractRequestBody,
} from "./extract-service";
import {
  runBatchExtraction,
  type BatchExtractionStorageAdapter,
} from "./extraction-client";
import {
  DEFAULT_REDACTION_RULES,
  type AppSettingsState,
  type ClinicalDocument,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyVariable,
} from "./types";

const NOW = "2026-11-27T12:00:00.000Z";

function makeStudy(overrides: Partial<Study> = {}): Study {
  return {
    id: "study-1",
    name: "Cohorte Pulmón Test",
    description: "Estudio de verificación de privacidad",
    codePrefix: "PULM",
    nextPatientSeq: 2,
    redactionRules: { ...DEFAULT_REDACTION_RULES },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVariable(): StudyVariable {
  return {
    id: "var-edad",
    studyId: "study-1",
    technicalName: "edad_diagnostico",
    label: "Edad al diagnóstico",
    section: "demografia",
    type: "numeric",
    options: [],
    aiInstruction: "Registrar edad al diagnóstico en años.",
    missingValue: "NR",
    unit: "años",
    order: 0,
    createdAt: NOW,
  };
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: "pat-1",
    studyId: "study-1",
    studyCode: "PULM-001",
    originalIdentifier: "HC-REAL-998123-JUAN-PEREZ",
    validationStatus: "pending",
    extractionStatus: "idle",
    researcherNotes: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<ClinicalDocument> = {}): ClinicalDocument {
  return {
    id: "doc-1",
    studyId: "study-1",
    patientId: "pat-1",
    filename: "Juan_Perez_DNI20456789_Epicrisis.pdf",
    fileType: "pdf",
    category: "epicrisis",
    rawText:
      "Paciente: Juan Pérez | DNI: 20.456.789. Varón de 64 años al diagnóstico con adenocarcinoma pulmonar estadio IVB.",
    redactedText:
      "Paciente: [REDACTADO] | DNI: [REDACTADO]. Varón de 64 años al diagnóstico con adenocarcinoma pulmonar estadio IVB.",
    redactionCount: 2,
    redactionSummary: { "Nombres en encabezados": 1, "DNI / Documentos": 1 },
    redactionConfirmed: true,
    uploadedAt: NOW,
    ...overrides,
  };
}

function makeStorage(params: {
  docs: ClinicalDocument[];
  settings?: Partial<AppSettingsState>;
}) {
  const patientUpdates: Array<{ patientId: string; patch: Partial<Patient> }> = [];
  const savedResults: Array<{
    patientId: string;
    records: ExtractionRecord[];
    patientPatch: Partial<Patient>;
  }> = [];

  const settings: AppSettingsState = {
    geminiApiKey: "test-gemini-key-placeholder",
    defaultModel: "gemini-2.5-flash",
    fallbackModel: "",
    customModel: "",
    rateLimitDelayMs: 0,
    useDemoMode: false,
    ...params.settings,
  };

  const storage: BatchExtractionStorageAdapter = {
    getSettings: async () => settings,
    saveSettings: async () => {},
    getPatientDocuments: async () => params.docs,
    getPatientExtractions: async () => [],
    updatePatient: async (patientId, patch) => {
      patientUpdates.push({ patientId, patch });
    },
    savePatientExtractionResult: async (res) => {
      savedResults.push(res);
    },
  };

  return { storage, patientUpdates, savedResults };
}

function makeMockFetch(onExtractPayload?: (payload: Record<string, unknown>) => void) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      calls.push({ url });
      return new Response(
        JSON.stringify({
          hasServerKey: false,
          hasManualKey: true,
          keySource: "manual",
          authenticated: true,
          connectionStatus: "connected",
          models: [{ id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }],
          recommendedModel: "gemini-2.5-flash",
          fallbackModel: null,
          checkedAt: NOW,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/api/extract")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      calls.push({ url, body: payload });
      onExtractPayload?.(payload);

      const docs = (payload.documents as Array<{ filename: string }>) || [];
      const targetDocAlias = docs[docs.length - 1]?.filename ?? "DOC-01";

      return new Response(
        JSON.stringify({
          extractions: {
            edad_diagnostico: {
              value: 64,
              status: "extracted",
              confidence: "alta",
              evidence_quote: "Varón de 64 años al diagnóstico",
              source_document: targetDocAlias,
              reasoning: null,
            },
          },
          mode: "gemini",
          modelUsed: "gemini-2.5-flash",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  return { fetchFn, calls };
}

describe("Helpers de privacidad en lib/redactor", () => {
  it("genera y valida identificadores neutros DOC-01, DOC-02", () => {
    assert.equal(formatNeutralDocumentId(0), "DOC-01");
    assert.equal(formatNeutralDocumentId(1), "DOC-02");
    assert.equal(
      toNeutralDocumentId("Juan_Perez_DNI20456789.pdf", 0),
      "DOC-01"
    );
    assert.equal(toNeutralDocumentId("doc-02", 0), "DOC-02");
  });

  it("exige el conjunto mínimo de reglas de identificación personal y rechaza una sola regla insuficiente", () => {
    assert.equal(isRedactionEnabled(DEFAULT_REDACTION_RULES), true);
    assert.deepEqual(getMissingMinimumRedactionRules(DEFAULT_REDACTION_RULES), []);

    // Ninguna regla activa
    assert.equal(
      isRedactionEnabled({
        maskDni: false,
        maskNames: false,
        maskPhones: false,
        maskEmails: false,
        maskAddresses: false,
        maskRecordIds: false,
        customTerms: [],
      }),
      false
    );

    // Una sola regla aislada (solo emails) es insuficiente
    assert.equal(
      isRedactionEnabled({
        maskDni: false,
        maskNames: false,
        maskPhones: false,
        maskEmails: true,
        maskAddresses: false,
        maskRecordIds: false,
        customTerms: [],
      }),
      false
    );

    // Solo términos personalizados sin DNI/nombres/HC es insuficiente
    assert.equal(
      isRedactionEnabled({
        maskDni: false,
        maskNames: false,
        maskPhones: false,
        maskEmails: false,
        maskAddresses: false,
        maskRecordIds: false,
        customTerms: ["Hospital Demo"],
      }),
      false
    );

    // Falta una regla del conjunto mínimo (maskRecordIds = false)
    assert.equal(
      isRedactionEnabled({
        maskDni: true,
        maskNames: true,
        maskPhones: true,
        maskEmails: true,
        maskAddresses: true,
        maskRecordIds: false,
        customTerms: [],
      }),
      false
    );
    assert.deepEqual(
      getMissingMinimumRedactionRules({
        maskDni: true,
        maskNames: true,
        maskPhones: false,
        maskEmails: false,
        maskAddresses: false,
        maskRecordIds: false,
        customTerms: [],
      }),
      ["maskRecordIds"]
    );

    // Conjunto mínimo completo (DNI + Nombres + N° HC) habilitado
    assert.equal(
      isRedactionEnabled({
        maskDni: true,
        maskNames: true,
        maskPhones: false,
        maskEmails: false,
        maskAddresses: false,
        maskRecordIds: true,
        customTerms: [],
      }),
      true
    );
  });

  it("valida texto redactado usable sin aceptar cadenas vacías o insuficientes", () => {
    assert.equal(hasUsableRedactedText(""), false);
    assert.equal(hasUsableRedactedText("   "), false);
    assert.equal(hasUsableRedactedText(undefined), false);
    assert.equal(
      hasUsableRedactedText("Paciente de 64 años con diagnóstico confirmado de carcinoma."),
      true
    );
  });
});

describe("Privacidad en runBatchExtraction (lib/extraction-client)", () => {
  it("envía explícitamente redactedText (no text), usa DOC-01/DOC-02 y mapea citas de vuelta localmente", async () => {
    const doc1 = makeDocument({
      id: "doc-a",
      filename: "Juan_Perez_DNI20456789_Epicrisis.pdf",
      redactedText:
        "Paciente: [REDACTADO] | Evolución clínica inicial sin datos personales visibles.",
    });
    const doc2 = makeDocument({
      id: "doc-b",
      filename: "Juan_Perez_20456789_Anatomia_Patologica.pdf",
      category: "patologia",
      redactedText:
        "Informe anatomopatológico de paciente [REDACTADO]: Varón de 64 años al diagnóstico con adenocarcinoma.",
    });

    const { storage, savedResults } = makeStorage({ docs: [doc1, doc2] });
    let capturedPayload: Record<string, unknown> | null = null;
    const { fetchFn } = makeMockFetch((payload) => {
      capturedPayload = payload;
    });

    const progress = await runBatchExtraction({
      study: makeStudy(),
      patients: [makePatient()],
      variables: [makeVariable()],
      shouldPause: () => false,
      shouldAbort: () => false,
      onProgress: () => {},
      fetchFn,
      storage,
      sleepFn: async () => {},
    });

    assert.equal(progress.succeeded, 1);
    assert.equal(progress.failed, 0);
    assert.ok(capturedPayload);

    const serialized = JSON.stringify(capturedPayload);
    assert.equal(serialized.includes("Juan_Perez"), false);
    assert.equal(serialized.includes("20456789"), false);
    assert.equal(serialized.includes("HC-REAL-998123"), false);

    assert.equal(capturedPayload["redactionEnabled"], true);
    assert.equal(capturedPayload["redactionConfirmed"], true);

    const sentDocs = capturedPayload["documents"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      sentDocs.map((d) => d.filename),
      ["DOC-01", "DOC-02"]
    );
    for (const d of sentDocs) {
      assert.equal(typeof d.redactedText, "string");
      assert.equal(d.redactionConfirmed, true);
      assert.equal("text" in d, false);
      assert.equal("rawText" in d, false);
    }

    assert.equal(savedResults.length, 1);
    assert.equal(savedResults[0].records.length, 1);
    assert.equal(savedResults[0].records[0].value, 64);
    assert.equal(savedResults[0].records[0].sourceDocumentId, "doc-b");
    assert.equal(
      savedResults[0].records[0].sourceDocumentName,
      "Juan_Perez_20456789_Anatomia_Patologica.pdf"
    );
  });

  it("bloquea la extracción si solo hay una regla insuficiente activada (no cumple el conjunto mínimo)", async () => {
    const study = makeStudy({
      redactionRules: {
        maskDni: false,
        maskNames: false,
        maskPhones: false,
        maskEmails: true,
        maskAddresses: false,
        maskRecordIds: false,
        customTerms: [],
      },
    });
    const { storage, patientUpdates } = makeStorage({ docs: [makeDocument()] });
    const { fetchFn, calls } = makeMockFetch();

    const progress = await runBatchExtraction({
      study,
      patients: [makePatient()],
      variables: [makeVariable()],
      shouldPause: () => false,
      shouldAbort: () => false,
      onProgress: () => {},
      fetchFn,
      storage,
      sleepFn: async () => {},
    });

    assert.equal(progress.failed, 1);
    assert.equal(progress.succeeded, 0);
    assert.equal(calls.length, 0);
    assert.match(progress.lastWarning || "", /reglas mínimas de protección de datos/i);
    assert.equal(patientUpdates[0]?.patch.extractionStatus, "error");
  });

  it("bloquea la extracción si algún documento no tiene redacción confirmada", async () => {
    const unconfirmedDoc = makeDocument({ redactionConfirmed: false });
    const { storage, patientUpdates } = makeStorage({ docs: [unconfirmedDoc] });
    const { fetchFn, calls } = makeMockFetch();

    const progress = await runBatchExtraction({
      study: makeStudy(),
      patients: [makePatient()],
      variables: [makeVariable()],
      shouldPause: () => false,
      shouldAbort: () => false,
      onProgress: () => {},
      fetchFn,
      storage,
      sleepFn: async () => {},
    });

    assert.equal(progress.failed, 1);
    assert.equal(progress.succeeded, 0);
    const extractCalls = calls.filter((c) => c.url.includes("/api/extract"));
    assert.equal(extractCalls.length, 0);

    const lastUpdate = patientUpdates[patientUpdates.length - 1];
    assert.equal(lastUpdate?.patch.extractionStatus, "error");
    assert.match(lastUpdate?.patch.extractionError || "", /confirmar la redacción/i);
  });

  it("nunca hace fallback a rawText cuando redactedText está vacío o ausente", async () => {
    const docMissingRedacted = makeDocument({
      redactionConfirmed: true,
      redactedText: "",
      rawText:
        "TEXTO_CRUDO_PROHIBIDO Paciente: María Elena Gómez DNI: 20.456.789 Edad: 62 años.",
    });
    const { storage, patientUpdates } = makeStorage({ docs: [docMissingRedacted] });
    const { fetchFn, calls } = makeMockFetch();

    const progress = await runBatchExtraction({
      study: makeStudy(),
      patients: [makePatient()],
      variables: [makeVariable()],
      shouldPause: () => false,
      shouldAbort: () => false,
      onProgress: () => {},
      fetchFn,
      storage,
      sleepFn: async () => {},
    });

    assert.equal(progress.failed, 1);
    assert.equal(progress.succeeded, 0);
    const extractCalls = calls.filter((c) => c.url.includes("/api/extract"));
    assert.equal(extractCalls.length, 0);

    const lastUpdate = patientUpdates[patientUpdates.length - 1];
    assert.equal(lastUpdate?.patch.extractionStatus, "error");
    assert.match(lastUpdate?.patch.extractionError || "", /texto redactado/i);
  });

  it("en pacientes multi-documento omite documentos sin redactedText sin enviar su rawText", async () => {
    const validDoc = makeDocument({
      id: "doc-valid",
      filename: "Carlos_Lopez_DNI11222333_Patologia.pdf",
      redactionConfirmed: true,
      redactedText:
        "Informe redactado válido: Varón de 64 años al diagnóstico con adenocarcinoma pulmonar.",
    });
    const missingRedactedDoc = makeDocument({
      id: "doc-missing",
      filename: "Carlos_Lopez_DNI11222333_SinRedactar.pdf",
      redactionConfirmed: true,
      redactedText: "",
      rawText:
        "SECRETO_RAW_TEXT_NO_ENVIAR Paciente Carlos López DNI 11.222.333 evolución clínica extensa.",
    });

    const { storage, savedResults } = makeStorage({
      docs: [validDoc, missingRedactedDoc],
    });
    let capturedPayload: Record<string, unknown> | null = null;
    const { fetchFn } = makeMockFetch((payload) => {
      capturedPayload = payload;
    });

    const progress = await runBatchExtraction({
      study: makeStudy(),
      patients: [makePatient()],
      variables: [makeVariable()],
      shouldPause: () => false,
      shouldAbort: () => false,
      onProgress: () => {},
      fetchFn,
      storage,
      sleepFn: async () => {},
    });

    assert.equal(progress.partial, 1);
    assert.equal(progress.failed, 0);
    assert.ok(capturedPayload);

    const serialized = JSON.stringify(capturedPayload);
    assert.equal(serialized.includes("SECRETO_RAW_TEXT_NO_ENVIAR"), false);
    assert.equal(serialized.includes("Carlos_Lopez"), false);
    assert.equal(serialized.includes("11222333"), false);

    const sentDocs = (
      capturedPayload as { documents: Array<{ filename: string; redactedText: string }> }
    ).documents;
    assert.equal(sentDocs.length, 1);
    assert.equal(sentDocs[0].filename, "DOC-01");
    assert.equal(savedResults[0].patientPatch.extractionStatus, "partial");
  });
});

describe("Privacidad en executeClinicalExtraction (lib/extract-service)", () => {
  it("rechaza una solicitud que solo trae text y no trae redactedText (nunca envía contenido a Gemini)", async () => {
    let called = false;
    const payloadOnlyText = {
      studyName: "Cohorte Pulmón",
      model: "gemini-2.5-flash",
      apiKey: "test-gemini-key-placeholder",
      redactionEnabled: true,
      redactionConfirmed: true,
      variables: [makeVariable()],
      documents: [
        {
          id: "d1",
          filename: "DOC-01",
          category: "epicrisis",
          text: "SOLO_TEXT_SIN_REDACTED_TEXT Paciente de 62 años con adenocarcinoma pulmonar.",
          redactionConfirmed: true,
        },
      ],
    } as unknown as ExtractRequestBody;

    const result = await executeClinicalExtraction(payloadOnlyText, {
      generateContent: async () => {
        called = true;
        return { text: "{}" };
      },
    });

    assert.equal(result.status, 422);
    assert.equal(called, false);
  });

  it("rechaza redactionEnabled ausente o false", async () => {
    let called = false;
    const generateContent = async () => {
      called = true;
      return { text: "{}" };
    };

    const missingEnabled = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionConfirmed: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
        ],
      },
      { generateContent }
    );

    assert.equal(missingEnabled.status, 422);
    assert.equal(called, false);

    const falseEnabled = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: false,
        redactionConfirmed: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
        ],
      },
      { generateContent }
    );

    assert.equal(falseEnabled.status, 422);
    assert.equal(called, false);
  });

  it("rechaza redactionConfirmed ausente o false a nivel de solicitud", async () => {
    let called = false;
    const generateContent = async () => {
      called = true;
      return { text: "{}" };
    };

    const missingConfirmed = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
        ],
      },
      { generateContent }
    );

    assert.equal(missingConfirmed.status, 422);
    assert.equal(called, false);

    const falseConfirmed = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: true,
        redactionConfirmed: false,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
        ],
      },
      { generateContent }
    );

    assert.equal(falseConfirmed.status, 422);
    assert.equal(called, false);
  });

  it("exige confirmación explícita en cada documento enviado (rechaza si falta en alguno)", async () => {
    let called = false;
    const generateContent = async () => {
      called = true;
      return { text: "{}" };
    };

    const oneDocUnconfirmed = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: true,
        redactionConfirmed: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
          {
            id: "d2",
            filename: "DOC-02",
            category: "patologia",
            redactedText:
              "Segundo documento redactado sin confirmación explícita en el documento.",
            redactionConfirmed: false,
          },
        ],
      },
      { generateContent }
    );

    assert.equal(oneDocUnconfirmed.status, 422);
    assert.equal(called, false);

    const oneDocMissingFlag = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: true,
        redactionConfirmed: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "DOC-01",
            category: "epicrisis",
            redactedText:
              "Texto redactado válido de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
          {
            id: "d2",
            filename: "DOC-02",
            category: "patologia",
            redactedText:
              "Segundo documento redactado con bandera redactionConfirmed ausente.",
          } as unknown as ExtractRequestBody["documents"][number],
        ],
      },
      { generateContent }
    );

    assert.equal(oneDocMissingFlag.status, 422);
    assert.equal(called, false);
  });

  it("procesa correctamente una solicitud válida con redactedText y reemplaza nombres originales por DOC-01/DOC-02", async () => {
    let sentContents = "";
    const result = await executeClinicalExtraction(
      {
        studyName: "Cohorte Pulmón",
        model: "gemini-2.5-flash",
        apiKey: "test-gemini-key-placeholder",
        redactionEnabled: true,
        redactionConfirmed: true,
        variables: [makeVariable()],
        documents: [
          {
            id: "d1",
            filename: "Maria_Elena_Gomez_DNI20456789_Epicrisis.pdf",
            category: "epicrisis",
            redactedText:
              "Paciente [REDACTADO] de 62 años al diagnóstico con adenocarcinoma pulmonar.",
            redactionConfirmed: true,
          },
          {
            id: "d2",
            filename: "Maria_Elena_Gomez_Patologia.pdf",
            category: "patologia",
            redactedText:
              "Biopsia pulmonar confirmatoria de adenocarcinoma moderadamente diferenciado.",
            redactionConfirmed: true,
          },
        ],
      },
      {
        generateContent: async (params) => {
          sentContents = params.contents;
          return {
            text: JSON.stringify({
              extractions: {
                edad_diagnostico: {
                  value: 62,
                  status: "extracted",
                  confidence: "alta",
                  evidence_quote: "Paciente [REDACTADO] de 62 años al diagnóstico",
                  source_document: "DOC-01",
                  reasoning: null,
                },
              },
            }),
          };
        },
      }
    );

    assert.equal(result.status, 200);
    assert.equal(sentContents.includes("Maria_Elena_Gomez"), false);
    assert.equal(sentContents.includes("20456789"), false);
    assert.equal(sentContents.includes("DOC-01"), true);
    assert.equal(sentContents.includes("DOC-02"), true);
    assert.equal(
      "extractions" in result.body && result.body.extractions.edad_diagnostico.value,
      62
    );
  });
});
