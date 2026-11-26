import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import {
  buildClinicalSystemPrompt,
  buildGeminiResponseSchema,
} from "@/lib/schema-builder";
import {
  normalizeGeminiModel,
  type GeminiExtractionResponse,
  type GeminiModel,
  type GeminiVariableExtractionOutput,
  type StudyVariable,
} from "@/lib/types";

interface ExtractRequestBody {
  studyName: string;
  model?: GeminiModel;
  apiKey?: string;
  forceMock?: boolean;
  variables: StudyVariable[];
  documents: Array<{
    id: string;
    filename: string;
    category: string;
    text: string;
  }>;
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
 * Extractor heurístico local (Modo Mock) para pruebas inmediatas sin API Key.
 * Garantiza citas verbatim reales tomadas del texto del documento.
 */
function runLocalMockExtraction(
  variables: StudyVariable[],
  documents: ExtractRequestBody["documents"]
): Record<string, GeminiVariableExtractionOutput> {
  const results: Record<string, GeminiVariableExtractionOutput> = {};

  const searchInDocs = (
    regex: RegExp
  ): { match: RegExpMatchArray; doc: ExtractRequestBody["documents"][number] } | null => {
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

    // 1. Edad
    if (variable.type === "numeric" && /edad|age|años/.test(hint)) {
      const found = searchInDocs(/\b(\d{2})\s*a[ñn]os\b/i);
      if (found && found.match.index !== undefined) {
        results[key] = {
          value: Number(found.match[1]),
          status: "extracted",
          confidence: "alta",
          evidence_quote: findSentenceWithMatch(found.doc.text, found.match.index, found.match[0].length),
          source_document: found.doc.filename,
          reasoning: "Extraído en modo demostración local (sin API key).",
        };
        continue;
      }
    }

    // 2. ECOG
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

    // 3. Sexo
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

    // 4. Fechas
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
          reasoning: "Fecha detectada por heurística local; verificar criterio de fecha con Gemini o revisión manual.",
        };
        continue;
      }
    }

    // 5. Categórico único o múltiple: buscar menciones literales de opciones
    if (
      (variable.type === "categorical_single" ||
        variable.type === "categorical_multiple") &&
      variable.options.length > 0
    ) {
      const matchedOptions: string[] = [];
      let firstDoc: ExtractRequestBody["documents"][number] | null = null;
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
          reasoning: "Coincidencia detectada en modo local sin API Key; revisar contexto clínico.",
        };
        continue;
      }
    }

    // 6. Booleano (toxicidad, cirugía, radioterapia)
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

    // 7. Biomarcadores / Esquema de tratamiento (texto breve)
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
            reasoning: "Extracto molecular en modo demostración local.",
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
            reasoning: "Extracto terapéutico en modo demostración local.",
          };
          continue;
        }
      }
    }

    // Si no se halló evidencia explícita -> missing
    results[key] = {
      value: null,
      status: "missing",
      confidence: "baja",
      evidence_quote: null,
      source_document: null,
      reasoning:
        "No se halló evidencia explícita en modo local. Configure su GEMINI_API_KEY para extracción clínica profunda.",
    };
  }

  return results;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ExtractRequestBody;

    if (!body.variables || body.variables.length === 0) {
      return NextResponse.json(
        { error: "Debe definir al menos una variable en el diccionario antes de extraer." },
        { status: 400 }
      );
    }

    if (!body.documents || body.documents.length === 0) {
      return NextResponse.json(
        { error: "El paciente no posee documentos clínicos cargados." },
        { status: 400 }
      );
    }

    const effectiveApiKey = (body.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || "");
    const model: GeminiModel = normalizeGeminiModel(body.model);

    // Modo Mock automático si no hay API key configurada o si el usuario solicita modo demo
    if (body.forceMock || !effectiveApiKey) {
      const mockExtractions = runLocalMockExtraction(body.variables, body.documents);
      const response: GeminiExtractionResponse = {
        extractions: mockExtractions,
        mode: "mock",
        modelUsed: "mock-heuristico-local",
        warning:
          "No se detectó GEMINI_API_KEY configurada. Se ejecutó el motor heurístico local de demostración. Configura tu API Key en Ajustes para usar Gemini (gemini-3.8-flash).",
      };
      return NextResponse.json(response);
    }

    const systemInstruction = buildClinicalSystemPrompt(
      body.studyName || "Estudio Oncológico",
      body.variables
    );
    const responseJsonSchema = buildGeminiResponseSchema(body.variables);

    const formattedDocuments = body.documents
      .map(
        (doc, idx) =>
          `=== [DOCUMENTO ${idx + 1}: ${doc.filename} | Categoría: ${doc.category}] ===\n${doc.text}\n=== [FIN DOCUMENTO: ${doc.filename}] ===`
      )
      .join("\n\n");

    const userPrompt = `Analiza los siguientes documentos clínicos seudoanonimizados pertenecientes a un único paciente y extrae estrictamente las variables del diccionario según las reglas establecidas.\n\n${formattedDocuments}`;

    const ai = new GoogleGenAI({ apiKey: effectiveApiKey });

    const aiResponse = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseJsonSchema,
      },
    });

    const rawText = aiResponse.text;
    if (!rawText) {
      return NextResponse.json(
        { error: "La API de Gemini devolvió una respuesta vacía." },
        { status: 502 }
      );
    }

    let parsed: { extractions?: Record<string, GeminiVariableExtractionOutput> };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { error: "La respuesta de Gemini no pudo parsearse como JSON válido." },
        { status: 502 }
      );
    }

    const rawMap = parsed.extractions ?? {};
    const normalized: Record<string, GeminiVariableExtractionOutput> = {};

    for (const v of body.variables) {
      const cell = rawMap[v.technicalName];
      if (!cell || cell.status === "missing" || cell.value === null || cell.value === undefined) {
        normalized[v.technicalName] = {
          value: null,
          status: "missing",
          confidence: cell?.confidence ?? "baja",
          evidence_quote: null,
          source_document: null,
          reasoning: cell?.reasoning ?? null,
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
          evidence_quote: cell.evidence_quote ?? null,
          source_document: cell.source_document ?? null,
          reasoning: cell.reasoning ?? null,
        };
      }
    }

    const response: GeminiExtractionResponse = {
      extractions: normalized,
      mode: "gemini",
      modelUsed: model,
    };

    return NextResponse.json(response);
  } catch (err: unknown) {
    const errorObj = err as { status?: number; message?: string };
    const status = typeof errorObj?.status === "number" ? errorObj.status : 500;
    const message =
      errorObj?.message || "Error inesperado al comunicarse con la API de Gemini.";

    if (status === 429 || /429|quota|rate\s*limit|RESOURCE_EXHAUSTED/i.test(message)) {
      return NextResponse.json(
        {
          error: "Límite de tasa alcanzado en Gemini API (429). Reintentando automáticamente...",
          retryable: true,
        },
        { status: 429 }
      );
    }

    if (
      status === 503 ||
      /503|UNAVAILABLE|high\s*demand|overloaded|temporarily\s*unavailable/i.test(message)
    ) {
      return NextResponse.json(
        {
          error:
            "Gemini API temporalmente saturada (503 UNAVAILABLE - alta demanda). Reintentando automáticamente...",
          retryable: true,
        },
        { status: 503 }
      );
    }

    if (status === 401 || status === 403 || /API_KEY_INVALID|permission/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "API Key de Gemini inválida o sin permisos. Verifica tu clave en Configuración.",
          retryable: false,
        },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { error: message, retryable: status >= 500 },
      { status: status >= 400 && status < 600 ? status : 500 }
    );
  }
}
