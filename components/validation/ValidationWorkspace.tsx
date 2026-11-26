"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Highlighter,
  Info,
  Save,
  Sparkles,
} from "lucide-react";
import { db, generateId } from "@/lib/db";
import { isRecordPresent } from "@/lib/stats";
import {
  DOCUMENT_CATEGORY_LABELS,
  VALIDATION_STATUS_LABELS,
  VARIABLE_SECTION_LABELS,
  type ClinicalDocument,
  type ConfidenceLevel,
  type ExtractedValue,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyVariable,
  type ValidationStatus,
  type VariableSection,
} from "@/lib/types";
import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui/primitives";

interface ValidationWorkspaceProps {
  study: Study;
  variables: StudyVariable[];
  patients: Patient[];
  documents: ClinicalDocument[];
  extractions: ExtractionRecord[];
  initialPatientId?: string | null;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
  onGoToIngestion: () => void;
}

function findQuoteRange(text: string, quote: string): { start: number; end: number } | null {
  if (!text || !quote) return null;
  const trimmed = quote.trim();
  if (trimmed.length < 3) return null;

  // 1. Coincidencia literal exacta
  const exactIdx = text.indexOf(trimmed);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + trimmed.length };
  }

  // 2. Coincidencia insensible a mayúsculas
  const lowerIdx = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (lowerIdx !== -1) {
    return { start: lowerIdx, end: lowerIdx + trimmed.length };
  }

  // 3. Coincidencia flexible de espacios en blanco / saltos de línea
  const escapedWords = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escapedWords.length > 0) {
    try {
      const flexRegex = new RegExp(escapedWords.join("\\s+"), "i");
      const m = text.match(flexRegex);
      if (m && m.index !== undefined) {
        return { start: m.index, end: m.index + m[0].length };
      }
    } catch {
      // Ignorar regex inválida
    }
  }

  // 4. Fallback: coincidencia con los primeros 40 caracteres de la cita
  if (trimmed.length > 40) {
    const partial = trimmed.slice(0, 40).toLowerCase();
    const pIdx = text.toLowerCase().indexOf(partial);
    if (pIdx !== -1) {
      return {
        start: pIdx,
        end: Math.min(text.length, pIdx + trimmed.length),
      };
    }
  }

  return null;
}

function getTrafficLight(record: ExtractionRecord | undefined): {
  dotClass: string;
  badgeVariant: "green" | "amber" | "red" | "slate";
  label: string;
} {
  if (!record || !isRecordPresent(record)) {
    return {
      dotClass: "bg-slate-300",
      badgeVariant: "slate",
      label: "Dato faltante",
    };
  }
  if (record.manuallyEdited || record.status === "manual") {
    return {
      dotClass: "bg-sky-600",
      badgeVariant: "green",
      label: "Editado / Curado",
    };
  }
  const conf: ConfidenceLevel | null = record.confidence;
  if (conf === "alta") {
    return {
      dotClass: "bg-emerald-500",
      badgeVariant: "green",
      label: "Alta confianza",
    };
  }
  if (conf === "media") {
    return {
      dotClass: "bg-amber-400",
      badgeVariant: "amber",
      label: "Media / Revisar",
    };
  }
  return {
    dotClass: "bg-rose-500",
    badgeVariant: "red",
    label: "Baja / Conflicto",
  };
}

export function ValidationWorkspace({
  study,
  variables,
  patients,
  documents,
  extractions,
  initialPatientId,
  onNotify,
  onGoToIngestion,
}: ValidationWorkspaceProps) {
  const [selectedPatientId, setSelectedPatientId] = useState<string>(
    initialPatientId || patients[0]?.id || ""
  );
  const [activeDocId, setActiveDocId] = useState<string>("");
  const [showOriginalText, setShowOriginalText] = useState(false);
  const [activeVariableId, setActiveVariableId] = useState<string | null>(null);
  const [activeQuote, setActiveQuote] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const highlightRef = useRef<HTMLElement | null>(null);

  const filteredPatients = useMemo(() => {
    if (statusFilter === "all") return patients;
    return patients.filter((p) => p.validationStatus === statusFilter);
  }, [patients, statusFilter]);

  // Asegurar paciente seleccionado válido
  useEffect(() => {
    if (initialPatientId && patients.some((p) => p.id === initialPatientId)) {
      setSelectedPatientId(initialPatientId);
    } else if (
      patients.length > 0 &&
      !patients.some((p) => p.id === selectedPatientId)
    ) {
      setSelectedPatientId(patients[0].id);
    }
  }, [initialPatientId, patients, selectedPatientId]);

  const activePatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) ?? null,
    [patients, selectedPatientId]
  );

  const patientDocs = useMemo(
    () => documents.filter((d) => d.patientId === activePatient?.id),
    [documents, activePatient]
  );

  const patientExtractionsByVar = useMemo(() => {
    const map = new Map<string, ExtractionRecord>();
    if (!activePatient) return map;
    for (const e of extractions) {
      if (e.patientId === activePatient.id) {
        map.set(e.variableId, e);
      }
    }
    return map;
  }, [extractions, activePatient]);

  useEffect(() => {
    setNotesDraft(activePatient?.researcherNotes ?? "");
    setActiveVariableId(null);
    setActiveQuote(null);
    if (patientDocs.length > 0) {
      setActiveDocId((prev) =>
        patientDocs.some((d) => d.id === prev) ? prev : patientDocs[0].id
      );
    } else {
      setActiveDocId("");
    }
  }, [activePatient?.id, patientDocs]);

  const activeDoc = useMemo(
    () => patientDocs.find((d) => d.id === activeDocId) ?? patientDocs[0] ?? null,
    [patientDocs, activeDocId]
  );

  const groupedVariables = useMemo(() => {
    const order: VariableSection[] = [
      "demografia",
      "enfermedad",
      "tratamiento",
      "desenlaces",
      "custom",
    ];
    const map = new Map<VariableSection, StudyVariable[]>();
    for (const sec of order) map.set(sec, []);
    for (const v of variables) {
      const list = map.get(v.section) || [];
      list.push(v);
      map.set(v.section, list);
    }
    return order
      .map((sec) => ({ section: sec, items: map.get(sec) || [] }))
      .filter((g) => g.items.length > 0);
  }, [variables]);

  // Scroll automático hacia la cita resaltada en el visor izquierdo
  useEffect(() => {
    if (activeQuote && highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [activeQuote, activeDocId, showOriginalText]);

  function handleSelectVariableForAudit(variableId: string) {
    setActiveVariableId(variableId);
    const rec = patientExtractionsByVar.get(variableId);
    const quote = rec?.evidenceQuote ?? null;
    setActiveQuote(quote);

    if (!quote) return;

    // Cambiar automáticamente a la pestaña del documento fuente donde está la cita
    if (rec?.sourceDocumentId && patientDocs.some((d) => d.id === rec.sourceDocumentId)) {
      setActiveDocId(rec.sourceDocumentId);
      return;
    }

    const matchingDoc = patientDocs.find(
      (d) =>
        findQuoteRange(d.redactedText, quote) !== null ||
        findQuoteRange(d.rawText, quote) !== null
    );
    if (matchingDoc) {
      setActiveDocId(matchingDoc.id);
    }
  }

  async function handleUpdateValue(variable: StudyVariable, newValue: ExtractedValue) {
    if (!activePatient) return;
    const prev = patientExtractionsByVar.get(variable.id);
    const now = new Date().toISOString();
    const isEmpty =
      newValue === null ||
      newValue === "" ||
      (Array.isArray(newValue) && newValue.length === 0);

    const record: ExtractionRecord = {
      id: prev?.id ?? generateId(),
      studyId: study.id,
      patientId: activePatient.id,
      variableId: variable.id,
      value: isEmpty ? null : newValue,
      status: isEmpty ? "missing" : "manual",
      confidence: isEmpty ? "baja" : "alta",
      evidenceQuote: prev?.evidenceQuote ?? null,
      sourceDocumentId: prev?.sourceDocumentId ?? null,
      sourceDocumentName: prev?.sourceDocumentName ?? null,
      reasoning: prev?.reasoning ?? null,
      manuallyEdited: true,
      modelUsed: prev?.modelUsed,
      updatedAt: now,
    };

    await db.extractions.put(record);
    if (activePatient.validationStatus === "pending") {
      await db.patients.update(activePatient.id, {
        validationStatus: "in_review",
        updatedAt: now,
      });
    }
  }

  async function handleSaveNotes() {
    if (!activePatient) return;
    await db.patients.update(activePatient.id, {
      researcherNotes: notesDraft,
      updatedAt: new Date().toISOString(),
    });
    onNotify(`Notas guardadas para ${activePatient.studyCode}.`, "success");
  }

  async function handleChangeValidationStatus(
    status: ValidationStatus,
    advanceToNext = false
  ) {
    if (!activePatient) return;
    await db.patients.update(activePatient.id, {
      validationStatus: status,
      researcherNotes: notesDraft,
      updatedAt: new Date().toISOString(),
    });
    onNotify(
      `Caso ${activePatient.studyCode} marcado como "${VALIDATION_STATUS_LABELS[status]}".`,
      "success"
    );

    if (advanceToNext) {
      const idx = filteredPatients.findIndex((p) => p.id === activePatient.id);
      if (idx !== -1 && idx + 1 < filteredPatients.length) {
        setSelectedPatientId(filteredPatients[idx + 1].id);
      }
    }
  }

  const displayedDocText = activeDoc
    ? showOriginalText
      ? activeDoc.rawText
      : activeDoc.redactedText
    : "";

  const quoteRange = useMemo(
    () => (activeQuote ? findQuoteRange(displayedDocText, activeQuote) : null),
    [displayedDocText, activeQuote]
  );

  if (patients.length === 0) {
    return (
      <Card className="p-10 text-center">
        <p className="text-base font-semibold text-slate-800">
          No hay casos cargados para validar.
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Carga historias clínicas y ejecuta la extracción en el Paso 2 para comenzar la
          auditoría Human-in-the-Loop.
        </p>
        <Button className="mt-4" onClick={onGoToIngestion}>
          Ir a Paso 2: Cargar HCD
        </Button>
      </Card>
    );
  }

  const currentIdx = filteredPatients.findIndex((p) => p.id === activePatient?.id);

  return (
    <div className="space-y-4">
      {/* Barra superior de selección de caso y aprobación */}
      <Card className="p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700"
            >
              <option value="all">Todos los casos ({patients.length})</option>
              <option value="pending">
                Pendientes ({patients.filter((p) => p.validationStatus === "pending").length})
              </option>
              <option value="in_review">
                En revisión ({patients.filter((p) => p.validationStatus === "in_review").length})
              </option>
              <option value="validated">
                Validados ({patients.filter((p) => p.validationStatus === "validated").length})
              </option>
            </select>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                disabled={currentIdx <= 0}
                onClick={() =>
                  currentIdx > 0 &&
                  setSelectedPatientId(filteredPatients[currentIdx - 1].id)
                }
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <select
                value={activePatient?.id ?? ""}
                onChange={(e) => setSelectedPatientId(e.target.value)}
                className="min-w-[200px] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs font-semibold text-slate-900"
              >
                {(filteredPatients.length > 0 ? filteredPatients : patients).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.studyCode} — {VALIDATION_STATUS_LABELS[p.validationStatus]}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="xs"
                disabled={currentIdx === -1 || currentIdx >= filteredPatients.length - 1}
                onClick={() =>
                  currentIdx < filteredPatients.length - 1 &&
                  setSelectedPatientId(filteredPatients[currentIdx + 1].id)
                }
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {activePatient && (
              <Badge
                variant={
                  activePatient.validationStatus === "validated"
                    ? "green"
                    : activePatient.validationStatus === "in_review"
                      ? "amber"
                      : "slate"
                }
              >
                {activePatient.validationStatus === "validated" && (
                  <CheckCircle2 className="h-3 w-3" />
                )}
                {activePatient.validationStatus === "in_review" && (
                  <Clock className="h-3 w-3" />
                )}
                {VALIDATION_STATUS_LABELS[activePatient.validationStatus]}
              </Badge>
            )}
          </div>

          {/* Botones de flujo de aprobación */}
          {activePatient && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={
                  activePatient.validationStatus === "pending" ? "secondary" : "outline"
                }
                size="xs"
                onClick={() => handleChangeValidationStatus("pending")}
              >
                Pendiente
              </Button>
              <Button
                variant={
                  activePatient.validationStatus === "in_review" ? "secondary" : "outline"
                }
                size="xs"
                onClick={() => handleChangeValidationStatus("in_review")}
              >
                En revisión
              </Button>
              <Button
                variant="success"
                size="sm"
                onClick={() => handleChangeValidationStatus("validated", true)}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Validar y Siguiente
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Split-Screen Principal */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* PANEL IZQUIERDO: Visor de Historia Clínica Multi-Documento con Resaltado */}
        <Card className="flex flex-col overflow-hidden lg:col-span-6 h-[calc(100vh-225px)] min-h-[540px]">
          <div className="border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <FileText className="h-4 w-4 text-sky-700" />
                Visor de Historia Clínica ({patientDocs.length} doc.)
              </div>
              <button
                type="button"
                onClick={() => setShowOriginalText((v) => !v)}
                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <Eye className="h-3 w-3" />
                {showOriginalText ? "Viendo Original (Local)" : "Viendo Redactado (PII)"}
              </button>
            </div>

            {/* Pestañas multi-documento */}
            {patientDocs.length > 0 && (
              <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
                {patientDocs.map((doc) => {
                  const isActive = doc.id === activeDoc?.id;
                  const hasQuote =
                    activeQuote &&
                    (findQuoteRange(doc.redactedText, activeQuote) !== null ||
                      findQuoteRange(doc.rawText, activeQuote) !== null);
                  return (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => setActiveDocId(doc.id)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition cursor-pointer ${
                        isActive
                          ? "border-sky-700 bg-sky-700 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <span>{doc.filename}</span>
                      <span
                        className={`text-[10px] ${
                          isActive ? "text-sky-100" : "text-slate-400"
                        }`}
                      >
                        ({DOCUMENT_CATEGORY_LABELS[doc.category]})
                      </span>
                      {hasQuote && (
                        <span
                          className="h-2 w-2 rounded-full bg-amber-300 ring-1 ring-amber-600"
                          title="Contiene la cita de la variable seleccionada"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Barra de evidencia activa */}
          {activeQuote && (
            <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
              <div className="flex items-center gap-1.5 min-w-0">
                <Highlighter className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                <span className="truncate">
                  Cita resaltada:{" "}
                  <strong className="font-mono text-[11px]">&ldquo;{activeQuote}&rdquo;</strong>
                </span>
              </div>
              {!quoteRange && (
                <Badge variant="amber">Cita en otro documento o aproximada</Badge>
              )}
            </div>
          )}

          {/* Cuerpo del texto clínico */}
          <div className="flex-1 overflow-y-auto bg-white p-4">
            {!activeDoc ? (
              <p className="text-xs text-slate-500">
                Este paciente no tiene documentos asociados.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-6 text-slate-800">
                {quoteRange ? (
                  <>
                    {displayedDocText.slice(0, quoteRange.start)}
                    <mark ref={highlightRef} className="evidence-highlight">
                      {displayedDocText.slice(quoteRange.start, quoteRange.end)}
                    </mark>
                    {displayedDocText.slice(quoteRange.end)}
                  </>
                ) : (
                  displayedDocText
                )}
              </pre>
            )}
          </div>
        </Card>

        {/* PANEL DERECHO: Formulario Estructurado de Auditoría por Secciones */}
        <Card className="flex flex-col overflow-hidden lg:col-span-6 h-[calc(100vh-225px)] min-h-[540px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-800">
                Variables Extraídas ({variables.length})
              </h3>
              <p className="text-[11px] text-slate-500">
                Haz clic en cualquier variable para localizar y resaltar su cita verbatim en el
                panel izquierdo.
              </p>
            </div>
            {/* Leyenda semáforo */}
            <div className="flex items-center gap-2.5 text-[10px] text-slate-600">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Alta
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-400" /> Media
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-rose-500" /> Baja
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-slate-300" /> Faltante
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {groupedVariables.map(({ section, items }) => (
              <div key={section} className="space-y-2.5">
                <h4 className="sticky top-0 z-10 -mx-1 bg-white/95 px-1 py-1 text-[11px] font-bold uppercase tracking-wider text-sky-800 border-b border-slate-100">
                  {VARIABLE_SECTION_LABELS[section]}
                </h4>

                {items.map((variable) => {
                  const rec = patientExtractionsByVar.get(variable.id);
                  const light = getTrafficLight(rec);
                  const isSelected = activeVariableId === variable.id;

                  return (
                    <div
                      key={variable.id}
                      onClick={() => handleSelectVariableForAudit(variable.id)}
                      className={`rounded-lg border p-3 transition cursor-pointer ${
                        isSelected
                          ? "border-sky-500 bg-sky-50/40 ring-2 ring-sky-200/70"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2.5 w-2.5 rounded-full shrink-0 ${light.dotClass}`}
                            title={light.label}
                          />
                          <span className="text-xs font-semibold text-slate-900">
                            {variable.label}
                          </span>
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                            {variable.technicalName}
                          </code>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Badge variant={light.badgeVariant}>{light.label}</Badge>
                          {rec?.evidenceQuote && (
                            <span
                              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                              title="Clic para resaltar evidencia"
                            >
                              <Highlighter className="h-2.5 w-2.5" />
                              Cita
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Control de edición directa según tipo de dato */}
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        {variable.type === "numeric" && (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              step="any"
                              placeholder={variable.missingValue || "NR"}
                              value={rec?.value ?? ""}
                              onFocus={() => handleSelectVariableForAudit(variable.id)}
                              onChange={(e) => {
                                const raw = e.target.value;
                                handleUpdateValue(
                                  variable,
                                  raw === "" ? null : Number(raw)
                                );
                              }}
                              className="font-mono text-xs"
                            />
                            {variable.unit && (
                              <span className="text-xs font-mono text-slate-500 shrink-0">
                                {variable.unit}
                              </span>
                            )}
                          </div>
                        )}

                        {variable.type === "date" && (
                          <Input
                            type="text"
                            placeholder="DD/MM/AAAA (o vacío si faltante)"
                            value={typeof rec?.value === "string" ? rec.value : ""}
                            onFocus={() => handleSelectVariableForAudit(variable.id)}
                            onChange={(e) =>
                              handleUpdateValue(variable, e.target.value)
                            }
                            className="font-mono text-xs"
                          />
                        )}

                        {variable.type === "categorical_single" && (
                          <Select
                            value={typeof rec?.value === "string" ? rec.value : ""}
                            onFocus={() => handleSelectVariableForAudit(variable.id)}
                            onChange={(e) =>
                              handleUpdateValue(variable, e.target.value || null)
                            }
                            className="text-xs"
                          >
                            <option value="">
                              — Dato faltante ({variable.missingValue || "NR"}) —
                            </option>
                            {variable.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </Select>
                        )}

                        {variable.type === "boolean" && (
                          <Select
                            value={typeof rec?.value === "string" ? rec.value : ""}
                            onFocus={() => handleSelectVariableForAudit(variable.id)}
                            onChange={(e) =>
                              handleUpdateValue(variable, e.target.value || null)
                            }
                            className="text-xs"
                          >
                            <option value="">
                              — Dato faltante ({variable.missingValue || "NR"}) —
                            </option>
                            <option value="Sí">Sí</option>
                            <option value="No">No</option>
                            <option value="Desconocido">Desconocido</option>
                          </Select>
                        )}

                        {variable.type === "categorical_multiple" && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {variable.options.map((opt) => {
                              const currentArr = Array.isArray(rec?.value)
                                ? rec.value
                                : [];
                              const checked = currentArr.includes(opt);
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => {
                                    handleSelectVariableForAudit(variable.id);
                                    const next = checked
                                      ? currentArr.filter((x) => x !== opt)
                                      : [...currentArr, opt];
                                    handleUpdateValue(variable, next);
                                  }}
                                  className={`rounded-full border px-2.5 py-0.5 text-xs transition cursor-pointer ${
                                    checked
                                      ? "border-sky-700 bg-sky-700 text-white"
                                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                                  }`}
                                >
                                  {checked ? "✓ " : "+ "}
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {variable.type === "text" && (
                          <Input
                            type="text"
                            placeholder={variable.missingValue || "NR"}
                            value={
                              Array.isArray(rec?.value)
                                ? rec.value.join("; ")
                                : rec?.value !== null && rec?.value !== undefined
                                  ? String(rec.value)
                                  : ""
                            }
                            onFocus={() => handleSelectVariableForAudit(variable.id)}
                            onChange={(e) =>
                              handleUpdateValue(variable, e.target.value)
                            }
                            className="text-xs"
                          />
                        )}
                      </div>

                      {/* Evidencia textual + Razonamiento IA */}
                      {rec?.evidenceQuote && (
                        <p className="mt-2 rounded bg-amber-50/70 px-2 py-1 text-[11px] text-amber-950 border border-amber-200/70">
                          <span className="font-semibold">Evidencia:</span>{" "}
                          <span className="font-mono">&ldquo;{rec.evidenceQuote}&rdquo;</span>
                          {rec.sourceDocumentName && (
                            <span className="ml-1.5 text-[10px] text-amber-700">
                              [{rec.sourceDocumentName}]
                            </span>
                          )}
                        </p>
                      )}

                      {rec?.reasoning && (
                        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-slate-600">
                          {rec.confidence === "baja" ? (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500 mt-0.5" />
                          ) : (
                            <Info className="h-3.5 w-3.5 shrink-0 text-sky-600 mt-0.5" />
                          )}
                          <span>{rec.reasoning}</span>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Notas del investigador por paciente */}
            {activePatient && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <Sparkles className="h-3.5 w-3.5 text-sky-700" />
                    Notas del Investigador ({activePatient.studyCode})
                  </label>
                  <Button size="xs" variant="outline" onClick={handleSaveNotes}>
                    <Save className="h-3 w-3" />
                    Guardar nota
                  </Button>
                </div>
                <Textarea
                  rows={3}
                  className="mt-2 bg-white text-xs"
                  placeholder="Observaciones metodológicas, criterios de exclusión o dudas para comité..."
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                />
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
