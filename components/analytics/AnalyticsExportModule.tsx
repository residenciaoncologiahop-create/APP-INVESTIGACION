"use client";

import React, { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  Calculator,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Plus,
  Search,
  Table2,
  Trash2,
} from "lucide-react";
import { db, generateId, sanitizeTechnicalName } from "@/lib/db";
import { exportStudyToCsv, exportStudyToXlsx } from "@/lib/exporters";
import {
  computeDateInterval,
  computeRowCompleteness,
  computeVariableStats,
  formatCellValueForDisplay,
  isRecordPresent,
  type ComputedIntervalColumn,
} from "@/lib/stats";
import {
  VALIDATION_STATUS_LABELS,
  VARIABLE_TYPE_LABELS,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyVariable,
} from "@/lib/types";
import { Badge, Button, Card, Input, Select } from "@/components/ui/primitives";

interface AnalyticsExportModuleProps {
  study: Study;
  variables: StudyVariable[];
  patients: Patient[];
  extractions: ExtractionRecord[];
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
  onOpenValidation: (patientId: string) => void;
}

export function AnalyticsExportModule({
  study,
  variables,
  patients,
  extractions,
  onNotify,
  onOpenValidation,
}: AnalyticsExportModuleProps) {
  const [activeTab, setActiveTab] = useState<"table" | "analytics">("table");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [validatedOnlyExport, setValidatedOnlyExport] = useState(false);

  // Columnas calculadas de intervalos de tiempo (Supervivencia Global / SLP)
  const [intervalColumns, setIntervalColumns] = useState<ComputedIntervalColumn[]>(() => {
    const diag = variables.find((v) => v.type === "date" && /diagnost/i.test(v.technicalName));
    const last = variables.find(
      (v) => v.type === "date" && /(ultimo_control|obito)/i.test(v.technicalName)
    );
    if (diag && last && diag.id !== last.id) {
      return [
        {
          id: "default-os",
          columnName: "seguimiento_sg_meses",
          startVariableId: diag.id,
          endVariableId: last.id,
          unit: "months",
        },
      ];
    }
    return [];
  });

  const dateVariables = useMemo(
    () => variables.filter((v) => v.type === "date"),
    [variables]
  );

  const [newColName, setNewColName] = useState("sg_meses");
  const [newStartVarId, setNewStartVarId] = useState(dateVariables[0]?.id ?? "");
  const [newEndVarId, setNewEndVarId] = useState(
    dateVariables[1]?.id ?? dateVariables[0]?.id ?? ""
  );
  const [newUnit, setNewUnit] = useState<"months" | "days">("months");

  // Edición inline en Tabla Maestra
  const [editingCell, setEditingCell] = useState<{
    patientId: string;
    variableId: string;
    draft: string;
  } | null>(null);

  const extractionIndex = useMemo(() => {
    const map = new Map<string, ExtractionRecord>();
    for (const e of extractions) {
      map.set(`${e.patientId}::${e.variableId}`, e);
    }
    return map;
  }, [extractions]);

  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return patients.filter((p) => {
      if (statusFilter !== "all" && p.validationStatus !== statusFilter) return false;
      if (!q) return true;
      if (p.studyCode.toLowerCase().includes(q)) return true;
      if (p.researcherNotes.toLowerCase().includes(q)) return true;
      for (const v of variables) {
        const rec = extractionIndex.get(`${p.id}::${v.id}`);
        if (
          rec?.value !== null &&
          rec?.value !== undefined &&
          String(rec.value).toLowerCase().includes(q)
        ) {
          return true;
        }
      }
      return false;
    });
  }, [patients, statusFilter, searchQuery, variables, extractionIndex]);

  const cohortSummary = useMemo(() => {
    const total = patients.length;
    const validated = patients.filter((p) => p.validationStatus === "validated").length;
    const inReview = patients.filter((p) => p.validationStatus === "in_review").length;
    const totalCells = total * variables.length;
    let presentCells = 0;
    for (const p of patients) {
      for (const v of variables) {
        if (isRecordPresent(extractionIndex.get(`${p.id}::${v.id}`))) {
          presentCells += 1;
        }
      }
    }
    const completenessPct =
      totalCells > 0 ? Math.round((presentCells / totalCells) * 100) : 0;
    return {
      total,
      validated,
      validatedPct: total > 0 ? Math.round((validated / total) * 100) : 0,
      inReview,
      completenessPct,
    };
  }, [patients, variables, extractionIndex]);

  const variableStatsList = useMemo(() => {
    return variables.map((v) => ({
      variable: v,
      stats: computeVariableStats(v, patients, extractionIndex),
    }));
  }, [variables, patients, extractionIndex]);

  const missingnessChartData = useMemo(() => {
    return variableStatsList.map(({ variable, stats }) => ({
      name: variable.technicalName,
      label: variable.label,
      completos: patients.length > 0 ? Number((100 - stats.missingPct).toFixed(1)) : 0,
      faltantes: stats.missingPct,
    }));
  }, [variableStatsList, patients.length]);

  async function commitInlineEdit() {
    if (!editingCell) return;
    const variable = variables.find((v) => v.id === editingCell.variableId);
    if (!variable) {
      setEditingCell(null);
      return;
    }

    const prev = extractionIndex.get(
      `${editingCell.patientId}::${editingCell.variableId}`
    );
    const trimmed = editingCell.draft.trim();
    let parsedValue: ExtractionRecord["value"] = trimmed === "" ? null : trimmed;

    if (trimmed !== "" && variable.type === "numeric") {
      const n = Number(trimmed.replace(",", "."));
      parsedValue = Number.isFinite(n) ? n : null;
    } else if (trimmed !== "" && variable.type === "categorical_multiple") {
      parsedValue = trimmed
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    await db.extractions.put({
      id: prev?.id ?? generateId(),
      studyId: study.id,
      patientId: editingCell.patientId,
      variableId: variable.id,
      value: parsedValue,
      status: parsedValue === null ? "missing" : "manual",
      confidence: parsedValue === null ? "baja" : "alta",
      evidenceQuote: prev?.evidenceQuote ?? null,
      sourceDocumentId: prev?.sourceDocumentId ?? null,
      sourceDocumentName: prev?.sourceDocumentName ?? null,
      reasoning: prev?.reasoning ?? null,
      manuallyEdited: true,
      modelUsed: prev?.modelUsed,
      updatedAt: new Date().toISOString(),
    });

    setEditingCell(null);
    onNotify("Celda actualizada en la base local.", "success");
  }

  function handleAddIntervalColumn(e: React.FormEvent) {
    e.preventDefault();
    const startId = newStartVarId || dateVariables[0]?.id;
    const endId = newEndVarId || dateVariables[1]?.id || dateVariables[0]?.id;
    const colName = sanitizeTechnicalName(newColName || "intervalo_meses");

    if (!startId || !endId) {
      onNotify("Necesitas al menos dos variables de tipo Fecha en el diccionario.", "error");
      return;
    }
    if (intervalColumns.some((c) => c.columnName === colName)) {
      onNotify(`Ya existe una columna calculada llamada "${colName}".`, "error");
      return;
    }

    setIntervalColumns((prev) => [
      ...prev,
      {
        id: generateId(),
        columnName: colName,
        startVariableId: startId,
        endVariableId: endId,
        unit: newUnit,
      },
    ]);
    onNotify(`Columna calculada "${colName}" agregada a la tabla y exportaciones.`, "success");
  }

  function handleExportXlsx() {
    exportStudyToXlsx({
      study,
      patients,
      variables,
      extractionIndex,
      intervalColumns,
      validatedOnly: validatedOnlyExport,
    });
    onNotify(
      "Libro Excel multipestaña (.xlsx) exportado (Base_Datos_Limpia, Diccionario_Variables, Auditoria_Citas_IA).",
      "success"
    );
  }

  function handleExportCsv() {
    exportStudyToCsv({
      study,
      patients,
      variables,
      extractionIndex,
      intervalColumns,
      validatedOnly: validatedOnlyExport,
    });
    onNotify("Archivo CSV (UTF-8 con BOM) listo para R, SPSS, Jamovi y Stata.", "success");
  }

  return (
    <div className="space-y-5">
      {/* Encabezado + Acciones de Exportación Científica */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            4. Tabla Maestra, Casuística Rápida y Exportación Científica
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Revisá la matriz completa de la cohorte, explorá estadística descriptiva y datos
            faltantes, calculá intervalos de supervivencia y exportá bases de datos listas para
            Excel, R, SPSS, Jamovi o Stata.
          </p>
        </div>

        <Card className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 bg-slate-50">
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={validatedOnlyExport}
              onChange={(e) => setValidatedOnlyExport(e.target.checked)}
              className="rounded border-slate-300 text-sky-700"
            />
            Solo casos Validados ({cohortSummary.validated})
          </label>
          <Button
            size="sm"
            variant="success"
            onClick={handleExportXlsx}
            disabled={patients.length === 0}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Exportar Excel (3 hojas)
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCsv}
            disabled={patients.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            Exportar CSV (UTF-8)
          </Button>
        </Card>
      </div>

      {/* KPIs de Resumen de Cohorte */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">N Total de Pacientes</p>
          <p className="mt-1 font-mono text-2xl font-bold text-slate-900">
            {cohortSummary.total}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">Casos Validados</p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-emerald-700">
              {cohortSummary.validatedPct}%
            </span>
            <span className="text-xs text-slate-500">
              ({cohortSummary.validated}/{cohortSummary.total})
            </span>
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">Completitud Global de Datos</p>
          <p className="mt-1 font-mono text-2xl font-bold text-sky-700">
            {cohortSummary.completenessPct}%
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">Variables + Intervalos</p>
          <p className="mt-1 font-mono text-2xl font-bold text-slate-900">
            {variables.length}
            {intervalColumns.length > 0 && (
              <span className="ml-1 text-sm font-medium text-sky-700">
                +{intervalColumns.length} calc.
              </span>
            )}
          </p>
        </Card>
      </div>

      {/* Selector de Sub-vista: Tabla Maestra vs Tablero de Casuística */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab("table")}
          className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition cursor-pointer ${
            activeTab === "table"
              ? "bg-sky-700 text-white shadow-xs"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Table2 className="h-4 w-4" />
          Tabla Maestra (Vista Planilla)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("analytics")}
          className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition cursor-pointer ${
            activeTab === "analytics"
              ? "bg-sky-700 text-white shadow-xs"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <BarChart3 className="h-4 w-4" />
          Tablero de Casuística e Intervalos KM
        </button>
      </div>

      {/* VISTA 1: TABLA MAESTRA */}
      {activeTab === "table" && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Buscar por ID o valor en cualquier columna..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">Estado:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
              >
                <option value="all">Todos ({patients.length})</option>
                <option value="validated">Solo Validados</option>
                <option value="in_review">En revisión</option>
                <option value="pending">Pendientes</option>
              </select>
              <span className="text-[11px] text-slate-400">
                (Doble clic en cualquier celda para editar)
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2.5 border-r border-slate-200">
                    ID Estudio
                  </th>
                  <th className="px-3 py-2.5">Estado</th>
                  <th className="px-3 py-2.5 text-center">Completitud</th>
                  {variables.map((v) => {
                    const st = variableStatsList.find((x) => x.variable.id === v.id)?.stats;
                    const colPct = st ? Math.round(100 - st.missingPct) : 0;
                    return (
                      <th key={v.id} className="px-3 py-2.5 min-w-[140px]">
                        <div className="font-mono text-sky-900">{v.technicalName}</div>
                        <div className="mt-0.5 text-[10px] font-normal text-slate-400">
                          {colPct}% completo
                        </div>
                      </th>
                    );
                  })}
                  {intervalColumns.map((col) => (
                    <th
                      key={col.id}
                      className="px-3 py-2.5 min-w-[140px] bg-sky-50/70 text-sky-900"
                    >
                      <div className="font-mono">{col.columnName}</div>
                      <div className="mt-0.5 text-[10px] font-normal text-sky-700">
                        Calculada ({col.unit === "months" ? "meses" : "días"})
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {filteredPatients.length === 0 ? (
                  <tr>
                    <td
                      colSpan={3 + variables.length + intervalColumns.length}
                      className="px-4 py-8 text-center text-slate-500"
                    >
                      No se encontraron pacientes con los filtros actuales.
                    </td>
                  </tr>
                ) : (
                  filteredPatients.map((patient) => {
                    const rowPct = computeRowCompleteness(
                      patient.id,
                      variables,
                      extractionIndex
                    );
                    return (
                      <tr key={patient.id} className="hover:bg-slate-50/80">
                        <td className="sticky left-0 z-10 bg-white px-3 py-2.5 border-r border-slate-200 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onOpenValidation(patient.id)}
                            className="text-sky-700 hover:underline cursor-pointer"
                            title="Abrir para revisión médica"
                          >
                            {patient.studyCode}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <Badge
                            variant={
                              patient.validationStatus === "validated"
                                ? "green"
                                : patient.validationStatus === "in_review"
                                  ? "amber"
                                  : "slate"
                            }
                          >
                            {VALIDATION_STATUS_LABELS[patient.validationStatus]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-center font-mono">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                              rowPct >= 90
                                ? "bg-emerald-50 text-emerald-700"
                                : rowPct >= 60
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-rose-50 text-rose-700"
                            }`}
                          >
                            {rowPct}%
                          </span>
                        </td>
                        {variables.map((v) => {
                          const rec = extractionIndex.get(`${patient.id}::${v.id}`);
                          const isEditing =
                            editingCell?.patientId === patient.id &&
                            editingCell?.variableId === v.id;
                          const display = formatCellValueForDisplay(
                            rec?.value,
                            v.missingValue || "NR"
                          );
                          const isMissing = !isRecordPresent(rec);

                          return (
                            <td
                              key={v.id}
                              onDoubleClick={() =>
                                setEditingCell({
                                  patientId: patient.id,
                                  variableId: v.id,
                                  draft: isMissing ? "" : display,
                                })
                              }
                              className={`px-3 py-2 max-w-[220px] truncate cursor-text ${
                                isMissing
                                  ? "text-slate-400 italic"
                                  : v.type === "numeric" || v.type === "date"
                                    ? "font-mono text-slate-800"
                                    : "text-slate-800"
                              }`}
                              title={display}
                            >
                              {isEditing ? (
                                <input
                                  autoFocus
                                  value={editingCell.draft}
                                  onChange={(e) =>
                                    setEditingCell((prev) =>
                                      prev ? { ...prev, draft: e.target.value } : null
                                    )
                                  }
                                  onBlur={commitInlineEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") commitInlineEdit();
                                    if (e.key === "Escape") setEditingCell(null);
                                  }}
                                  className="w-full rounded border border-sky-500 bg-white px-1.5 py-0.5 font-mono text-xs text-slate-900 focus:outline-none"
                                />
                              ) : (
                                display
                              )}
                            </td>
                          );
                        })}

                        {intervalColumns.map((col) => {
                          const sRec = extractionIndex.get(
                            `${patient.id}::${col.startVariableId}`
                          );
                          const eRec = extractionIndex.get(
                            `${patient.id}::${col.endVariableId}`
                          );
                          const diff = computeDateInterval(
                            sRec?.value,
                            eRec?.value,
                            col.unit
                          );
                          return (
                            <td
                              key={col.id}
                              className="bg-sky-50/30 px-3 py-2 font-mono font-medium text-sky-900"
                            >
                              {diff !== null ? diff : "NR"}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* VISTA 2: TABLERO DE CASUÍSTICA E INTERVALOS KM */}
      {activeTab === "analytics" && (
        <div className="space-y-5">
          {/* Calculadora Automática de Intervalos de Tiempo (Kaplan-Meier) */}
          <Card className="p-4 border-sky-200 bg-sky-50/40">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-sky-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                Calculadora Automática de Intervalos de Tiempo (Supervivencia Global / SLP)
              </h3>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Selecciona dos variables de fecha para generar automáticamente una columna
              numérica calculada (lista para análisis de Kaplan-Meier / Cox en R, SPSS o
              Jamovi). Se incluirá en la Tabla Maestra y en los archivos exportados.
            </p>

            {dateVariables.length < 2 ? (
              <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                Define al menos 2 variables de tipo <strong>Fecha (DD/MM/AAAA)</strong> en tu
                diccionario (ej. <code>fecha_diagnostico</code> y{" "}
                <code>fecha_ultimo_control</code>) para calcular intervalos.
              </p>
            ) : (
              <form
                onSubmit={handleAddIntervalColumn}
                className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-5 items-end"
              >
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-700">
                    Nombre de columna
                  </label>
                  <Input
                    required
                    value={newColName}
                    onChange={(e) => setNewColName(sanitizeTechnicalName(e.target.value))}
                    placeholder="sg_meses"
                    className="font-mono text-xs bg-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-700">
                    Fecha inicio (T0)
                  </label>
                  <Select
                    value={newStartVarId || dateVariables[0]?.id}
                    onChange={(e) => setNewStartVarId(e.target.value)}
                    className="text-xs bg-white"
                  >
                    {dateVariables.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} ({v.technicalName})
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-700">
                    Fecha fin / evento (T1)
                  </label>
                  <Select
                    value={newEndVarId || dateVariables[1]?.id}
                    onChange={(e) => setNewEndVarId(e.target.value)}
                    className="text-xs bg-white"
                  >
                    {dateVariables.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} ({v.technicalName})
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-700">
                    Unidad
                  </label>
                  <Select
                    value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value as "months" | "days")}
                    className="text-xs bg-white"
                  >
                    <option value="months">Meses (días / 30.4375)</option>
                    <option value="days">Días calendario</option>
                  </Select>
                </div>
                <Button type="submit" size="sm">
                  <Plus className="h-3.5 w-3.5" />
                  Calcular Columna
                </Button>
              </form>
            )}

            {intervalColumns.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {intervalColumns.map((col) => {
                  const vals = patients
                    .map((p) =>
                      computeDateInterval(
                        extractionIndex.get(`${p.id}::${col.startVariableId}`)?.value,
                        extractionIndex.get(`${p.id}::${col.endVariableId}`)?.value,
                        col.unit
                      )
                    )
                    .filter((x): x is number => x !== null)
                    .sort((a, b) => a - b);
                  const med =
                    vals.length > 0 ? vals[Math.floor(vals.length / 2)] : null;
                  return (
                    <div
                      key={col.id}
                      className="inline-flex items-center gap-2 rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-xs"
                    >
                      <code className="font-mono font-semibold text-sky-800">
                        {col.columnName}
                      </code>
                      <span className="text-slate-500">
                        n={vals.length}
                        {med !== null
                          ? ` · Mediana: ${med} ${col.unit === "months" ? "m" : "d"}`
                          : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setIntervalColumns((prev) => prev.filter((c) => c.id !== col.id))
                        }
                        className="text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Mapa de Datos Faltantes por Variable */}
          <Card className="p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Mapa de completitud y datos faltantes por variable
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Porcentaje de registros completos frente a datos faltantes por cada variable del
              estudio.
            </p>
            <div className="mt-4 h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={missingnessChartData}
                  margin={{ top: 8, right: 16, left: 0, bottom: 36 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="name"
                    angle={-25}
                    textAnchor="end"
                    interval={0}
                    tick={{ fontSize: 11, fill: "#475569" }}
                  />
                  <YAxis
                    domain={[0, 100]}
                    unit="%"
                    tick={{ fontSize: 11, fill: "#475569" }}
                  />
                  <Tooltip />
                  <Bar
                    dataKey="completos"
                    name="% Completos"
                    stackId="a"
                    fill="#0284c7"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="faltantes"
                    name="% Datos faltantes"
                    stackId="a"
                    fill="#e2e8f0"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Estadística Descriptiva Automática por Variable */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {variableStatsList.map(({ variable, stats }) => (
              <Card key={variable.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">
                      {variable.label}
                    </h4>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <code className="font-mono text-[11px] text-sky-800">
                        {variable.technicalName}
                      </code>
                      <Badge variant="slate">{VARIABLE_TYPE_LABELS[variable.type]}</Badge>
                    </div>
                  </div>
                  <Badge variant={stats.missing > 0 ? "amber" : "green"}>
                    n={stats.n} · faltantes: {stats.missing} ({stats.missingPct}%)
                  </Badge>
                </div>

                {stats.kind === "numeric" && (
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 font-mono text-xs">
                    <div>
                      <span className="text-[11px] font-sans text-slate-500">
                        Mediana (RIC)
                      </span>
                      <p className="mt-0.5 font-semibold text-slate-900">
                        {stats.median !== null
                          ? `${stats.median} (${stats.q1}–${stats.q3}, RIC ${stats.iqr})`
                          : "Sin datos"}
                      </p>
                    </div>
                    <div>
                      <span className="text-[11px] font-sans text-slate-500">
                        Media ± DE
                      </span>
                      <p className="mt-0.5 font-semibold text-slate-900">
                        {stats.mean !== null
                          ? `${stats.mean} ± ${stats.sd}`
                          : "Sin datos"}
                      </p>
                    </div>
                    <div className="col-span-2 border-t border-slate-200 pt-2 text-[11px] text-slate-600">
                      Rango (Mín – Máx):{" "}
                      <strong>
                        {stats.min !== null ? `${stats.min} – ${stats.max}` : "NR"}
                      </strong>
                      {variable.unit ? ` ${variable.unit}` : ""}
                    </div>
                  </div>
                )}

                {stats.kind === "categorical" && (
                  <div className="mt-3 space-y-2">
                    {stats.frequencies.length === 0 ? (
                      <p className="text-xs italic text-slate-400">
                        Sin datos extraídos aún.
                      </p>
                    ) : (
                      <>
                        <div className="space-y-1.5">
                          {stats.frequencies.map((freq) => (
                            <div key={freq.label} className="text-xs">
                              <div className="flex items-center justify-between">
                                <span className="text-slate-700 font-medium">
                                  {freq.label}
                                </span>
                                <span className="font-mono text-slate-800">
                                  {freq.n} ({freq.pct}%)
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-sky-600"
                                  style={{ width: `${Math.min(100, freq.pct)}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {stats.kind === "other" && (
                  <p className="mt-3 text-xs text-slate-600">
                    Valores únicos documentados:{" "}
                    <strong className="font-mono">{stats.uniqueCount}</strong>{" "}
                    <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600 ml-1" />
                  </p>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
