import type { RedactionRuleConfig } from "./types";

export const NEUTRAL_DOCUMENT_ID_REGEX = /^DOC-\d{2,}$/i;

export function formatNeutralDocumentId(index: number): string {
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return `DOC-${String(safeIndex + 1).padStart(2, "0")}`;
}

export function isNeutralDocumentId(value?: string | null): boolean {
  if (!value) return false;
  return NEUTRAL_DOCUMENT_ID_REGEX.test(value.trim());
}

export function toNeutralDocumentId(
  filename: string | undefined | null,
  fallbackIndex: number
): string {
  if (filename && isNeutralDocumentId(filename)) {
    return filename.trim().toUpperCase();
  }
  return formatNeutralDocumentId(fallbackIndex);
}

export const MINIMUM_REDACTION_RULE_LABELS = {
  maskDni: "DNI / CUIL / Documento",
  maskNames: "Nombres en encabezados",
  maskRecordIds: "N° Historia Clínica / Afiliado",
} as const;

export type MinimumRedactionRuleKey = keyof typeof MINIMUM_REDACTION_RULE_LABELS;

export const MINIMUM_REQUIRED_REDACTION_RULES: readonly MinimumRedactionRuleKey[] = [
  "maskDni",
  "maskNames",
  "maskRecordIds",
];

/**
 * Devuelve las reglas mínimas de identificación personal que faltan activar.
 * Nota: este conjunto mínimo actúa como barrera preventiva básica mediante regex
 * y NO garantiza anonimización completa; siempre requiere revisión humana previa.
 */
export function getMissingMinimumRedactionRules(
  rules?: RedactionRuleConfig | null
): MinimumRedactionRuleKey[] {
  if (!rules) return [...MINIMUM_REQUIRED_REDACTION_RULES];
  return MINIMUM_REQUIRED_REDACTION_RULES.filter((key) => rules[key] !== true);
}

/**
 * Verifica si está habilitado el conjunto mínimo obligatorio de reglas de
 * identificación personal (DNI/CUIL, nombres en encabezados y N° de historia clínica).
 * Las expresiones regulares reducen la exposición de datos filiatorios pero no
 * garantizan anonimización completa por sí solas.
 */
export function isRedactionEnabled(rules?: RedactionRuleConfig | null): boolean {
  return getMissingMinimumRedactionRules(rules).length === 0;
}

export function hasUsableRedactedText(
  redactedText: unknown,
  minChars = 30
): boolean {
  if (typeof redactedText !== "string") return false;
  const cleaned = redactedText
    .replace(/---\s*Página siguiente\s*---/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= minChars;
}

export interface RedactionResult {
  redactedText: string;
  totalRedactions: number;
  countsByType: Record<string, number>;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPattern(
  text: string,
  regex: RegExp,
  typeKey: string,
  counts: Record<string, number>,
  replacer?: (...args: string[]) => string
): string {
  return text.replace(regex, (...args) => {
    counts[typeKey] = (counts[typeKey] || 0) + 1;
    if (replacer) {
      return replacer(...(args as string[]));
    }
    return "[REDACTADO]";
  });
}

/**
 * Filtro local de privacidad / seudoanonimización previo al envío a la IA.
 * Detecta y enmascara datos filiatorios (DNI, nombres en encabezados,
 * teléfonos, emails, domicilios, N° de historia clínica y términos personalizados).
 */
export function redactClinicalText(
  rawText: string,
  rules: RedactionRuleConfig
): RedactionResult {
  if (!rawText) {
    return { redactedText: "", totalRedactions: 0, countsByType: {} };
  }

  let output = rawText;
  const counts: Record<string, number> = {};

  // 1. Correos electrónicos
  if (rules.maskEmails) {
    output = applyPattern(
      output,
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "Emails",
      counts
    );
  }

  // 2. DNI / CUIL / CUIT / Pasaporte / Cédula
  if (rules.maskDni) {
    output = applyPattern(
      output,
      /(\b(?:D\.?\s*N\.?\s*I\.?|C\.?\s*I\.?|CUIL|CUIT|RUT|CURP|Documento|Doc\.?|Cédula)\s*(?:N[°ºo.]?)?\s*[:#-]?\s*)(\d{1,3}(?:[.\-\s]?\d{3}){1,2}(?:-[\dkK])?)/gi,
      "DNI / Documentos",
      counts,
      (_match, prefix) => `${prefix}[REDACTADO]`
    );
    // CUIL/CUIT suelto formato XX-XXXXXXXX-X
    output = applyPattern(
      output,
      /\b\d{2}-\d{7,8}-\d\b/g,
      "DNI / Documentos",
      counts
    );
  }

  // 3. Números de historia clínica / afiliado / socio
  if (rules.maskRecordIds) {
    output = applyPattern(
      output,
      /(\b(?:H\.?\s*C\.?\s*D?\.?|HCL|Historia\s+Cl[ií]nica|N[°º]\s*HC|N[°º]\s*Afiliado|Afiliado|Socio|Credencial|Matr[ií]cula)\s*(?:N[°ºo.]?)?\s*[:#-]?\s*)([A-Z0-9][A-Z0-9\-/]{3,20})/gi,
      "N° Historia Clínica",
      counts,
      (_match, prefix) => `${prefix}[REDACTADO]`
    );
  }

  // 4. Teléfonos / Celulares
  if (rules.maskPhones) {
    output = applyPattern(
      output,
      /(\b(?:Tel[eé]fono|Tel\.?|Celular|Cel\.?|M[oó]vil|WhatsApp)\s*[:#-]?\s*)(\+?\d[\d\s\-()]{6,18}\d)/gi,
      "Teléfonos",
      counts,
      (_match, prefix) => `${prefix}[REDACTADO]`
    );
    // Números internacionales +54 / +52 / +34 / +56 / +57 / +1
    output = applyPattern(
      output,
      /\+\d{1,3}[\s-]?(?:9[\s-]?)?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
      "Teléfonos",
      counts
    );
  }

  // 5. Domicilios / Direcciones
  if (rules.maskAddresses) {
    output = applyPattern(
      output,
      /(\b(?:Domicilio|Direcci[oó]n|Residencia)\s*[:#-]?\s*)([^\n|;]{4,80})/gi,
      "Direcciones",
      counts,
      (_match, prefix) => `${prefix}[REDACTADO]`
    );
  }

  // 6. Nombres propios detectados en encabezados clínicos
  if (rules.maskNames) {
    output = applyPattern(
      output,
      /(\b(?:Paciente|Apellido\s+y\s+Nombre|Nombre\s+y\s+Apellido|Nombre\s+del\s+paciente|Nombre|Titular|Familiar\s+responsable)\s*[:#-]\s*)([^\n|;,]{2,70})/gi,
      "Nombres en encabezados",
      counts,
      (_match, prefix) => `${prefix}[REDACTADO]`
    );
  }

  // 7. Términos personalizados definidos por el investigador
  if (rules.customTerms && rules.customTerms.length > 0) {
    for (const rawTerm of rules.customTerms) {
      const term = rawTerm.trim();
      if (term.length < 2) continue;
      const customRegex = new RegExp(escapeRegExp(term), "gi");
      output = applyPattern(output, customRegex, "Términos personalizados", counts);
    }
  }

  const totalRedactions = Object.values(counts).reduce((acc, n) => acc + n, 0);

  return {
    redactedText: output,
    totalRedactions,
    countsByType: counts,
  };
}
