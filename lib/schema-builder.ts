import type { StudyVariable } from "./types";

export interface JsonSchemaObject {
  type: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonSchemaObject;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
}

function buildValueSchema(variable: StudyVariable): JsonSchemaObject {
  const missingRule = `Si el dato no está explícito en la historia clínica, devolver null (nunca inventar ni inferir).`;

  switch (variable.type) {
    case "numeric":
      return {
        type: ["number", "null"],
        description: `Valor numérico para "${variable.label}"${
          variable.unit ? ` (unidad: ${variable.unit})` : ""
        }. ${variable.aiInstruction || ""} ${missingRule}`.trim(),
      };

    case "date":
      return {
        type: ["string", "null"],
        description: `Fecha exacta en formato estricto DD/MM/AAAA para "${variable.label}". ${
          variable.aiInstruction || ""
        } ${missingRule}`.trim(),
      };

    case "categorical_single": {
      const cleanOptions = variable.options
        .map((o) => o.trim())
        .filter(Boolean);
      const schema: JsonSchemaObject = {
        type: ["string", "null"],
        description: `Categoría única permitida para "${variable.label}". Opciones válidas: ${
          cleanOptions.join(" | ") || "Según texto"
        }. ${variable.aiInstruction || ""} ${missingRule}`.trim(),
      };
      if (cleanOptions.length > 0) {
        schema.enum = cleanOptions;
      }
      return schema;
    }

    case "categorical_multiple": {
      const cleanOptions = variable.options
        .map((o) => o.trim())
        .filter(Boolean);
      const itemSchema: JsonSchemaObject = {
        type: "string",
      };
      if (cleanOptions.length > 0) {
        itemSchema.enum = cleanOptions;
      }
      return {
        type: ["array", "null"],
        items: itemSchema,
        description: `Lista de categorías aplicables para "${variable.label}". Opciones permitidas: ${
          cleanOptions.join(" | ") || "Según texto"
        }. ${variable.aiInstruction || ""} ${missingRule}`.trim(),
      };
    }

    case "boolean":
      return {
        type: ["string", "null"],
        enum: ["Sí", "No", "Desconocido"],
        description: `Valor booleano clínico ("Sí", "No" o "Desconocido") para "${variable.label}". ${
          variable.aiInstruction || ""
        } Si no se menciona en absoluto, devolver null y status "missing".`.trim(),
      };

    case "text":
    default:
      return {
        type: ["string", "null"],
        description: `Texto breve normalizado para "${variable.label}". ${
          variable.aiInstruction || ""
        } ${missingRule}`.trim(),
      };
  }
}

/**
 * Transforma dinámicamente el Diccionario de Variables del estudio en un
 * JSON Schema estricto compatible con Structured Outputs de Google Gemini.
 */
export function buildGeminiResponseSchema(
  variables: StudyVariable[]
): JsonSchemaObject {
  const extractionProperties: Record<string, JsonSchemaObject> = {};
  const requiredKeys: string[] = [];

  for (const variable of variables) {
    const key = variable.technicalName;
    requiredKeys.push(key);
    extractionProperties[key] = {
      type: "object",
      description: `Extracción auditada de la variable ${variable.technicalName} (${variable.label}).`,
      properties: {
        value: buildValueSchema(variable),
        status: {
          type: "string",
          enum: ["extracted", "missing"],
          description:
            'Usar "extracted" solo si el dato figura explícitamente en los documentos. Usar "missing" si no está documentado.',
        },
        confidence: {
          type: "string",
          enum: ["alta", "media", "baja"],
          description:
            '"alta" cuando el dato es explícito e inequívoco; "media" si hay leve ambigüedad o requiere confirmación; "baja" si hay conflicto entre documentos o dato faltante.',
        },
        evidence_quote: {
          type: ["string", "null"],
          description:
            "Cita textual EXACTA (verbatim, sin parafrasear ni alterar puntuación) copiada de la historia clínica que respalda el valor. Debe ser una frase o fragmento corto (15-220 caracteres) localizable literalmente en el texto. Null si status es missing.",
        },
        source_document: {
          type: ["string", "null"],
          description:
            "Nombre exacto del documento fuente donde se halló la cita (según los encabezados [DOCUMENTO: ...]). Null si status es missing.",
        },
        reasoning: {
          type: ["string", "null"],
          description:
            "Aclaración clínica breve SOLO si hubo fechas en conflicto, interpretación de criterios (ej. TNM/AJCC) o ambigüedad; null si es directo.",
        },
      },
      required: [
        "value",
        "status",
        "confidence",
        "evidence_quote",
        "source_document",
        "reasoning",
      ],
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      extractions: {
        type: "object",
        properties: extractionProperties,
        required: requiredKeys,
        additionalProperties: false,
      },
    },
    required: ["extractions"],
    additionalProperties: false,
  };
}

export function buildClinicalSystemPrompt(
  studyName: string,
  variables: StudyVariable[]
): string {
  const codebookGuide = variables
    .map((v, idx) => {
      const optionsText =
        v.options.length > 0 ? ` | Opciones permitidas: [${v.options.join(", ")}]` : "";
      const unitText = v.unit ? ` | Unidad: ${v.unit}` : "";
      return `${idx + 1}. \`${v.technicalName}\` (${v.label}) — Tipo: ${v.type}${unitText}${optionsText}
   Criterio clínico: ${v.aiInstruction || "Extraer estrictamente lo reportado en la HCD."}
   Valor ante dato faltante: devolver value=null y status="missing".`;
    })
    .join("\n");

  return `Eres un médico oncólogo senior y especialista en curación de datos clínicos para investigación observacional retrospectiva.
Estudio activo: "${studyName}".

REGLAS OBLIGATORIAS DE RIGOR CIENTÍFICO:
1. EVIDENCIA ESTRICTA: Extrae información ÚNICAMENTE si figura de forma explícita en los documentos clínicos proporcionados. Está ESTRICTAMENTE PROHIBIDO asumir, inferir, extrapolar o completar valores por probabilidad clínica.
2. DATOS FALTANTES: Si una variable no está explícitamente documentada, debes devolver obligatoriamente \`value: null\`, \`status: "missing"\`, \`confidence: "baja"\`, \`evidence_quote: null\`.
3. TRAZABILIDAD VERBATIM: Para cada variable extraída, \`evidence_quote\` debe ser una cita textual EXACTA copiada carácter por carácter del texto de la historia clínica (sin modificar tildes, números ni puntuación) para permitir resaltado automático en el visor de auditoría.
4. DOCUMENTO FUENTE: Indica en \`source_document\` el nombre exacto del archivo indicado en el marcador \`[DOCUMENTO: nombre]\`.
5. FECHAS: Normaliza siempre todas las fechas al formato \`DD/MM/AAAA\`. Si solo consta mes/año y no hay instrucción contraria, marca \`confidence: "media"\` y acláralo en \`reasoning\`.
6. CONFLICTOS: Si dos documentos del mismo paciente contradicen un dato (ej. dos fechas o dos estadios), aplica la instrucción clínica de la variable (ej. prioridad a anatomía patológica o informe más reciente), asigna \`confidence: "media"\` o \`"baja"\` y explica el conflicto en \`reasoning\`.
7. CATEGORÍAS CERRADAS: Para variables categóricas, utiliza EXCLUSIVAMENTE los valores exactos de la lista de opciones permitidas.

DICCIONARIO DE VARIABLES A EXTRAER:
${codebookGuide}`;
}
