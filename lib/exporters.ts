"use client";

import * as XLSX from "xlsx";
import {
  computeDateInterval,
  formatCellValueForDisplay,
  type ComputedIntervalColumn,
} from "./stats";
import {
  VALIDATION_STATUS_LABELS,
  VARIABLE_SECTION_LABELS,
  VARIABLE_TYPE_LABELS,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyVariable,
} from "./types";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugifyFilename(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function buildCleanRows(
  patients: Patient[],
  variables: StudyVariable[],
  extractionIndex: Map<string, ExtractionRecord>,
  intervalColumns: ComputedIntervalColumn[]
): Record<string, string | number>[] {
  return patients.map((p) => {
    const row: Record<string, string | number> = {
      id_estudio: p.studyCode,
      estado_validacion: VALIDATION_STATUS_LABELS[p.validationStatus],
    };

    for (const v of variables) {
      const rec = extractionIndex.get(`${p.id}::${v.id}`);
      if (!rec || rec.status === "missing" || rec.value === null || rec.value === undefined) {
        row[v.technicalName] = v.missingValue || "NR";
      } else if (v.type === "numeric" && typeof rec.value === "number") {
        row[v.technicalName] = rec.value;
      } else {
        row[v.technicalName] = formatCellValueForDisplay(rec.value, v.missingValue || "NR");
      }
    }

    for (const col of intervalColumns) {
      const startRec = extractionIndex.get(`${p.id}::${col.startVariableId}`);
      const endRec = extractionIndex.get(`${p.id}::${col.endVariableId}`);
      const diff = computeDateInterval(startRec?.value, endRec?.value, col.unit);
      row[col.columnName] = diff !== null ? diff : "NR";
    }

    row.notas_investigador = p.researcherNotes || "";
    return row;
  });
}

/**
 * Exporta libro Excel (.xlsx) con 3 pestañas científicas obligatorias:
 * 1) Base_Datos_Limpia
 * 2) Diccionario_Variables
 * 3) Auditoria_Citas_IA
 */
export function exportStudyToXlsx(params: {
  study: Study;
  patients: Patient[];
  variables: StudyVariable[];
  extractionIndex: Map<string, ExtractionRecord>;
  intervalColumns: ComputedIntervalColumn[];
  validatedOnly?: boolean;
}) {
  const filteredPatients = params.validatedOnly
    ? params.patients.filter((p) => p.validationStatus === "validated")
    : params.patients;

  // Hoja 1: Base de Datos Limpia
  const cleanRows = buildCleanRows(
    filteredPatients,
    params.variables,
    params.extractionIndex,
    params.intervalColumns
  );

  // Hoja 2: Diccionario de Variables (Codebook)
  const dictRows = params.variables.map((v, idx) => ({
    orden: idx + 1,
    nombre_tecnico: v.technicalName,
    etiqueta_legible: v.label,
    seccion: VARIABLE_SECTION_LABELS[v.section],
    tipo_dato: VARIABLE_TYPE_LABELS[v.type],
    unidad: v.unit || "",
    opciones_permitidas: v.options.join(" | "),
    valor_dato_faltante: v.missingValue || "NR",
    instruccion_clinica_ia: v.aiInstruction,
  }));

  for (const col of params.intervalColumns) {
    const vStart = params.variables.find((v) => v.id === col.startVariableId);
    const vEnd = params.variables.find((v) => v.id === col.endVariableId);
    dictRows.push({
      orden: dictRows.length + 1,
      nombre_tecnico: col.columnName,
      etiqueta_legible: `Intervalo calculado (${col.unit === "months" ? "meses" : "días"})`,
      seccion: "Desenlaces / Supervivencia (Calculada)",
      tipo_dato: "Numérico (Calculado)",
      unidad: col.unit === "months" ? "meses" : "días",
      opciones_permitidas: "",
      valor_dato_faltante: "NR",
      instruccion_clinica_ia: `Calculado automáticamente: ${vEnd?.technicalName ?? "?"} - ${vStart?.technicalName ?? "?"}`,
    });
  }

  // Hoja 3: Auditoría de Citas IA
  const auditRows: Record<string, string | number>[] = [];
  for (const p of filteredPatients) {
    for (const v of params.variables) {
      const rec = params.extractionIndex.get(`${p.id}::${v.id}`);
      auditRows.push({
        id_estudio: p.studyCode,
        estado_validacion_caso: VALIDATION_STATUS_LABELS[p.validationStatus],
        variable_tecnica: v.technicalName,
        etiqueta: v.label,
        valor_final: formatCellValueForDisplay(rec?.value, v.missingValue || "NR"),
        estado_celda: rec?.status ?? "missing",
        confianza_ia: rec?.confidence ?? "",
        editado_manualmente: rec?.manuallyEdited ? "Sí" : "No",
        documento_fuente: rec?.sourceDocumentName ?? "",
        cita_textual_verbatim: rec?.evidenceQuote ?? "",
        razonamiento_ia: rec?.reasoning ?? "",
        modelo_usado: rec?.modelUsed ?? "",
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const wsData = XLSX.utils.json_to_sheet(cleanRows.length > 0 ? cleanRows : [{ aviso: "Sin casos que cumplan el filtro" }]);
  const wsDict = XLSX.utils.json_to_sheet(dictRows.length > 0 ? dictRows : [{ aviso: "Sin variables" }]);
  const wsAudit = XLSX.utils.json_to_sheet(auditRows.length > 0 ? auditRows : [{ aviso: "Sin registros de auditoría" }]);

  XLSX.utils.book_append_sheet(wb, wsData, "Base_Datos_Limpia");
  XLSX.utils.book_append_sheet(wb, wsDict, "Diccionario_Variables");
  XLSX.utils.book_append_sheet(wb, wsAudit, "Auditoria_Citas_IA");

  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const suffix = params.validatedOnly ? "_VALIDADOS" : "_COMPLETA";
  downloadBlob(
    blob,
    `${slugifyFilename(params.study.name)}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx`
  );
}

function escapeCsvCell(val: string | number): string {
  const s = String(val ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Exporta CSV limpio en UTF-8 con BOM (compatible directo con R, SPSS, Jamovi, Stata, Excel y Python).
 */
export function exportStudyToCsv(params: {
  study: Study;
  patients: Patient[];
  variables: StudyVariable[];
  extractionIndex: Map<string, ExtractionRecord>;
  intervalColumns: ComputedIntervalColumn[];
  validatedOnly?: boolean;
}) {
  const filteredPatients = params.validatedOnly
    ? params.patients.filter((p) => p.validationStatus === "validated")
    : params.patients;

  const rows = buildCleanRows(
    filteredPatients,
    params.variables,
    params.extractionIndex,
    params.intervalColumns
  );

  const headers = [
    "id_estudio",
    "estado_validacion",
    ...params.variables.map((v) => v.technicalName),
    ...params.intervalColumns.map((c) => c.columnName),
    "notas_investigador",
  ];

  const csvLines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => headers.map((h) => escapeCsvCell(row[h] ?? "")).join(",")),
  ];

  const bomCsv = "\uFEFF" + csvLines.join("\r\n");
  const blob = new Blob([bomCsv], { type: "text/csv;charset=utf-8;" });
  const suffix = params.validatedOnly ? "_VALIDADOS" : "_COMPLETA";
  downloadBlob(
    blob,
    `${slugifyFilename(params.study.name)}${suffix}_${new Date().toISOString().slice(0, 10)}.csv`
  );
}

/**
 * Exporta localmente la "Tabla Llave" (ID de estudio <-> Identificador original)
 * estrictamente separada de la base de datos científica.
 */
export function exportKeyTableCsv(study: Study, patients: Patient[]) {
  const headers = [
    "id_estudio_seudoanonimizado",
    "identificador_original_local",
    "fecha_carga",
  ];
  const lines = [
    headers.join(","),
    ...patients.map((p) =>
      [
        escapeCsvCell(p.studyCode),
        escapeCsvCell(p.originalIdentifier),
        escapeCsvCell(p.createdAt.slice(0, 10)),
      ].join(",")
    ),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
  downloadBlob(
    blob,
    `TABLA_LLAVE_CONFIDENCIAL_${slugifyFilename(study.codePrefix || study.name)}_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`
  );
}

export function downloadJsonFile(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  downloadBlob(blob, filename);
}
