"use client";

import React, { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Cpu,
  Eye,
  FileText,
  KeyRound,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Square,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { formatStoredErrorForDisplay } from "@/lib/ai-errors";
import {
  allocateNextStudyCode,
  db,
  deletePatientCascade,
  generateId,
  getAppSettings,
} from "@/lib/db";
import {
  inferPatientGroupKey,
  isDocumentLowTextPdf,
  parseClinicalFile,
  SCANNED_PDF_WARNING,
} from "@/lib/document-parser";
import {
  runBatchExtraction,
  type BatchQueueProgress,
} from "@/lib/extraction-client";
import { exportKeyTableCsv } from "@/lib/exporters";
import { redactClinicalText } from "@/lib/redactor";
import {
  DOCUMENT_CATEGORY_LABELS,
  type ClinicalDocument,
  type DocumentCategory,
  type ExtractionRecord,
  type ModelsDiscoveryResponse,
  type Patient,
  type RedactionRuleConfig,
  type Study,
  type StudyVariable,
} from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Select,
  Textarea,
} from "@/components/ui/primitives";

interface IngestionModuleProps {
  study: Study;
  variables: StudyVariable[];
  patients: Patient[];
  documents: ClinicalDocument[];
  extractions: ExtractionRecord[];
  modelsDiscovery?: ModelsDiscoveryResponse | null;
  demoModeEnabled?: boolean;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
  onGoToValidation: (patientId?: string) => void;
}

interface DuplicateFileMatch {
  file: File;
  reasons: string[];
  existingDocName: string;
  existingPatientCode: string;
}

interface PendingDuplicateReview {
  allFiles: File[];
  duplicates: DuplicateFileMatch[];
  nonDuplicates: File[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function IngestionModule({
  study,
  variables,
  patients,
  documents,
  extractions,
  modelsDiscovery,
  demoModeEnabled,
  onNotify,
  onGoToValidation,
}: IngestionModuleProps) {
  const [dragging, setDragging] = useState(false);
  const [parsingFiles, setParsingFiles] = useState(false);
  const [targetPatientId, setTargetPatientId] = useState<string>("__auto__");
  const [customTermsInput, setCustomTermsInput] = useState(
    (study.redactionRules.customTerms || []).join(", ")
  );

  // Modal pegar texto manual
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteTargetPatientId, setPasteTargetPatientId] = useState<string>("__new__");
  const [pasteOrigId, setPasteOrigId] = useState("");
  const [pasteFilename, setPasteFilename] = useState("Evolucion_Clinica.txt");
  const [pasteCategory, setPasteCategory] = useState<DocumentCategory>("evolucion");
  const [pasteText, setPasteText] = useState("");

  // Modal vista previa de redacción
  const [previewDoc, setPreviewDoc] = useState<ClinicalDocument | null>(null);

  // Modal advertencia de archivos duplicados
  const [pendingDuplicates, setPendingDuplicates] =
    useState<PendingDuplicateReview | null>(null);

  // Configuración guardada en este equipo
  const savedSettings = useLiveQuery(() => getAppSettings(), [], undefined);
  const [isRunningQueue, setIsRunningQueue] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const pauseRef = useRef(false);
  const abortRef = useRef(false);
  const [queueProgress, setQueueProgress] = useState<BatchQueueProgress | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const docsByPatient = useMemo(() => {
    const map = new Map<string, ClinicalDocument[]>();
    for (const d of documents) {
      const list = map.get(d.patientId) || [];
      list.push(d);
      map.set(d.patientId, list);
    }
    return map;
  }, [documents]);

  const missingColsByPatient = useMemo(() => {
    const extractedByPat = new Map<string, Set<string>>();
    for (const e of extractions) {
      const set = extractedByPat.get(e.patientId) || new Set<string>();
      set.add(e.variableId);
      extractedByPat.set(e.patientId, set);
    }
    const counts = new Map<string, number>();
    for (const p of patients) {
      const set = extractedByPat.get(p.id) || new Set<string>();
      const missing = variables.filter((v) => !set.has(v.id)).length;
      counts.set(p.id, missing);
    }
    return counts;
  }, [patients, variables, extractions]);

  const patientCodeById = useMemo(
    () => new Map(patients.map((p) => [p.id, p.studyCode])),
    [patients]
  );

  const errorPatients = useMemo(
    () => patients.filter((p) => p.extractionStatus === "error"),
    [patients]
  );

  const totalPendingNewColumns = useMemo(() => {
    let total = 0;
    for (const p of patients) {
      if ((missingColsByPatient.get(p.id) ?? 0) > 0 && p.lastExtractedAt) {
        total += 1;
      }
    }
    return total;
  }, [patients, missingColsByPatient]);

  async function updateRedactionRules(partial: Partial<RedactionRuleConfig>) {
    const nextRules: RedactionRuleConfig = {
      ...study.redactionRules,
      ...partial,
    };
    await db.studies.update(study.id, {
      redactionRules: nextRules,
      updatedAt: new Date().toISOString(),
    });

    // Reaplicar redacción a todos los documentos del estudio automáticamente
    const updatedDocs = documents.map((doc) => {
      const red = redactClinicalText(doc.rawText, nextRules);
      return {
        ...doc,
        redactedText: red.redactedText,
        redactionCount: red.totalRedactions,
        redactionSummary: red.countsByType,
      };
    });
    if (updatedDocs.length > 0) {
      await db.documents.bulkPut(updatedDocs);
    }
    onNotify("Reglas de seudoanonimización actualizadas y reaplicadas localmente.", "info");
  }

  function handleIncomingFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const duplicates: DuplicateFileMatch[] = [];
    const nonDuplicates: File[] = [];

    // Detectar duplicados contra documentos ya cargados en el estudio (nombre o tamaño idéntico)
    const seenBatchNames = new Set<string>();
    const seenBatchSizes = new Map<number, string>();

    for (const file of files) {
      const lowerName = file.name.trim().toLowerCase();
      const reasons: string[] = [];
      let matchedDocName = "";
      let matchedPatientCode = "";

      const existingByName = documents.find(
        (d) => d.filename.trim().toLowerCase() === lowerName
      );
      const existingBySize =
        file.size > 0
          ? documents.find((d) => {
              const docBytes =
                d.fileSize !== undefined
                  ? d.fileSize
                  : d.fileType === "txt"
                    ? new Blob([d.rawText]).size
                    : undefined;
              return docBytes !== undefined && docBytes === file.size;
            })
          : undefined;

      if (existingByName) {
        reasons.push("Mismo nombre de archivo");
        matchedDocName = existingByName.filename;
        matchedPatientCode =
          patientCodeById.get(existingByName.patientId) ?? "Estudio actual";
      }
      if (existingBySize) {
        reasons.push(`Tamaño idéntico (${formatFileSize(file.size)})`);
        if (!matchedDocName) {
          matchedDocName = existingBySize.filename;
          matchedPatientCode =
            patientCodeById.get(existingBySize.patientId) ?? "Estudio actual";
        }
      }

      // También detectar duplicados dentro del mismo lote que se está subiendo
      if (seenBatchNames.has(lowerName)) {
        reasons.push("Repetido en esta misma selección");
        if (!matchedDocName) {
          matchedDocName = file.name;
          matchedPatientCode = "Lote actual";
        }
      } else if (file.size > 0 && seenBatchSizes.has(file.size)) {
        reasons.push(`Tamaño idéntico a "${seenBatchSizes.get(file.size)}" en este lote`);
        if (!matchedDocName) {
          matchedDocName = seenBatchSizes.get(file.size) || file.name;
          matchedPatientCode = "Lote actual";
        }
      }

      seenBatchNames.add(lowerName);
      if (file.size > 0 && !seenBatchSizes.has(file.size)) {
        seenBatchSizes.set(file.size, file.name);
      }

      if (reasons.length > 0) {
        duplicates.push({
          file,
          reasons,
          existingDocName: matchedDocName,
          existingPatientCode: matchedPatientCode,
        });
      } else {
        nonDuplicates.push(file);
      }
    }

    if (duplicates.length > 0) {
      setPendingDuplicates({
        allFiles: files,
        duplicates,
        nonDuplicates,
      });
      return;
    }

    void processUploadedFiles(files);
  }

  async function processUploadedFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setParsingFiles(true);
    let addedDocs = 0;
    let addedPatients = 0;
    const errors: string[] = [];

    try {
      const parsedItems = [];
      for (const file of files) {
        try {
          const parsed = await parseClinicalFile(file);
          parsedItems.push(parsed);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : `Error leyendo ${file.name}`);
        }
      }

      if (parsedItems.length === 0) {
        if (errors.length) onNotify(errors.join(" "), "error");
        return;
      }

      const now = new Date().toISOString();

      if (targetPatientId !== "__auto__" && targetPatientId !== "__each__") {
        // Agregar todos los archivos a un paciente existente seleccionado
        for (const item of parsedItems) {
          const red = redactClinicalText(item.text, study.redactionRules);
          await db.documents.add({
            id: generateId(),
            studyId: study.id,
            patientId: targetPatientId,
            filename: item.filename,
            fileType: item.fileType,
            fileSize: item.fileSize,
            category: item.category,
            rawText: item.text,
            redactedText: red.redactedText,
            redactionCount: red.totalRedactions,
            redactionSummary: red.countsByType,
            redactionConfirmed: false,
            isLowTextPdf: item.isLowTextPdf,
            extractedCharCount: item.extractedCharCount,
            uploadedAt: now,
          });
          addedDocs += 1;
        }
      } else {
        // Agrupar por prefijo de paciente (si __auto__) o 1 paciente por archivo (si __each__)
        const groups = new Map<string, typeof parsedItems>();
        for (const item of parsedItems) {
          const key =
            targetPatientId === "__auto__"
              ? inferPatientGroupKey(item.filename)
              : `${item.filename}-${Math.random()}`;
          const list = groups.get(key) || [];
          list.push(item);
          groups.set(key, list);
        }

        for (const [groupKey, groupFiles] of groups.entries()) {
          const studyCode = await allocateNextStudyCode(study.id);
          const patientId = generateId();
          const origId =
            targetPatientId === "__auto__"
              ? groupKey
              : groupFiles[0].filename.replace(/\.[^.]+$/, "");

          await db.patients.add({
            id: patientId,
            studyId: study.id,
            studyCode,
            originalIdentifier: origId,
            validationStatus: "pending",
            extractionStatus: "idle",
            researcherNotes: "",
            createdAt: now,
            updatedAt: now,
          });
          addedPatients += 1;

          for (const item of groupFiles) {
            const red = redactClinicalText(item.text, study.redactionRules);
            await db.documents.add({
              id: generateId(),
              studyId: study.id,
              patientId,
              filename: item.filename,
              fileType: item.fileType,
              fileSize: item.fileSize,
              category: item.category,
              rawText: item.text,
              redactedText: red.redactedText,
              redactionCount: red.totalRedactions,
              redactionSummary: red.countsByType,
              redactionConfirmed: false,
              isLowTextPdf: item.isLowTextPdf,
              extractedCharCount: item.extractedCharCount,
              uploadedAt: now,
            });
            addedDocs += 1;
          }
        }
      }

      const scannedCount = parsedItems.filter((item) => item.isLowTextPdf).length;
      const summary =
        addedPatients > 0
          ? `Se cargaron ${addedDocs} documento(s) en ${addedPatients} nuevo(s) paciente(s).`
          : `Se adjuntaron ${addedDocs} documento(s) al paciente seleccionado.`;
      const scannedNotice =
        scannedCount > 0
          ? ` Atención: ${scannedCount} PDF parece una imagen escaneada sin texto seleccionable (se conservó el archivo y se marcó con alerta).`
          : "";
      onNotify(
        errors.length
          ? `${summary}${scannedNotice} Avisos: ${errors.join("; ")}`
          : `${summary}${scannedNotice}`,
        errors.length || scannedCount > 0 ? "info" : "success"
      );
    } finally {
      setParsingFiles(false);
    }
  }

  async function handleSavePastedText(e: React.FormEvent) {
    e.preventDefault();
    if (!pasteText.trim()) return;
    const now = new Date().toISOString();
    let patId = pasteTargetPatientId;

    if (patId === "__new__") {
      const studyCode = await allocateNextStudyCode(study.id);
      patId = generateId();
      await db.patients.add({
        id: patId,
        studyId: study.id,
        studyCode,
        originalIdentifier: pasteOrigId.trim() || `Texto pegado (${studyCode})`,
        validationStatus: "pending",
        extractionStatus: "idle",
        researcherNotes: "",
        createdAt: now,
        updatedAt: now,
      });
    }

    const red = redactClinicalText(pasteText.trim(), study.redactionRules);
    await db.documents.add({
      id: generateId(),
      studyId: study.id,
      patientId: patId,
      filename: pasteFilename.trim() || "Historia_Clinica_Pegada.txt",
      fileType: "pasted",
      category: pasteCategory,
      rawText: pasteText.trim(),
      redactedText: red.redactedText,
      redactionCount: red.totalRedactions,
      redactionSummary: red.countsByType,
      redactionConfirmed: false,
      uploadedAt: now,
    });

    setPasteText("");
    setPasteOrigId("");
    setPasteModalOpen(false);
    onNotify("Texto clínico agregado y seudoanonimizado localmente.", "success");
  }

  async function handleConfirmRedaction(doc: ClinicalDocument) {
    await db.documents.update(doc.id, { redactionConfirmed: true });
    setPreviewDoc({ ...doc, redactionConfirmed: true });
    onNotify(`Redacción confirmada para ${doc.filename}.`, "success");
  }

  async function handleDeleteDocument(doc: ClinicalDocument) {
    await db.documents.delete(doc.id);
    onNotify(`Documento "${doc.filename}" eliminado.`, "info");
  }

  async function handleDeletePatient(p: Patient) {
    const ok = window.confirm(
      `¿Eliminar al paciente ${p.studyCode} y todos sus documentos y extracciones?`
    );
    if (!ok) return;
    await deletePatientCascade(p.id);
    onNotify(`Paciente ${p.studyCode} eliminado.`, "info");
  }

  async function launchExtractionQueue(
    targetPatients: Patient[],
    opts: { missingVariablesOnly?: boolean; forceReextract?: boolean } = {}
  ) {
    if (variables.length === 0) {
      onNotify("Primero definí al menos una variable en el Paso 1 (Variables del estudio).", "error");
      return;
    }
    if (targetPatients.length === 0) {
      onNotify("No hay pacientes pendientes para analizar.", "info");
      return;
    }

    pauseRef.current = false;
    abortRef.current = false;
    setIsPaused(false);
    setIsRunningQueue(true);

    try {
      const finalProgress = await runBatchExtraction({
        study,
        patients: targetPatients,
        variables,
        missingVariablesOnly: opts.missingVariablesOnly,
        forceReextract: opts.forceReextract,
        shouldPause: () => pauseRef.current,
        shouldAbort: () => abortRef.current,
        onProgress: (p) => setQueueProgress(p),
      });

      if (abortRef.current) {
        onNotify("Extracción detenida por el investigador.", "info");
      } else {
        const parts = [`${finalProgress.succeeded} completos`];
        if (finalProgress.partial > 0) parts.push(`${finalProgress.partial} parciales`);
        if (finalProgress.failed > 0) parts.push(`${finalProgress.failed} con error`);
        if (finalProgress.skipped > 0) parts.push(`${finalProgress.skipped} omitidos`);

        const tone =
          finalProgress.failed > 0
            ? "error"
            : finalProgress.partial > 0
              ? "info"
              : "success";
        onNotify(`Extracción finalizada: ${parts.join(", ")}.`, tone);
      }
    } finally {
      setIsRunningQueue(false);
      setIsPaused(false);
    }
  }

  const activeModelSummary = (() => {
    if (demoModeEnabled || savedSettings?.useDemoMode) {
      return "Modo de demostración (sin IA)";
    }
    if (modelsDiscovery?.authenticated && modelsDiscovery.connectionStatus === "connected") {
      const preferredId =
        savedSettings?.customModel?.trim() ||
        savedSettings?.defaultModel?.trim() ||
        modelsDiscovery.recommendedModel ||
        "";
      const found = modelsDiscovery.models.find((m) => m.id === preferredId);
      return found ? `IA lista · ${found.displayName}` : `IA lista · ${preferredId || "Automático"}`;
    }
    if (modelsDiscovery?.connectionStatus === "configured_disconnected") {
      return "IA sin conexión (revisá Configuración y Respaldo)";
    }
    return "IA no configurada (usará modo de demostración)";
  })();

  return (
    <div className="space-y-5">
      {/* Título */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            2. Cargar historias clínicas
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Cargá archivos PDF, Word o texto desde tu equipo, agrupá los informes de cada paciente
            y ocultá automáticamente los datos identificatorios antes de analizar.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (patients.length === 0) {
                onNotify("Aún no hay pacientes para generar la Tabla Llave.", "info");
                return;
              }
              exportKeyTableCsv(study, patients);
              onNotify(
                "Tabla Llave descargada en tu equipo (mantener separada de la base científica).",
                "success"
              );
            }}
          >
            <KeyRound className="h-3.5 w-3.5 text-amber-600" />
            Descargar Tabla Llave (CSV)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPasteModalOpen(true)}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            Pegar historia clínica
          </Button>
        </div>
      </div>

      {/* Grid superior: Zona de Carga + Reglas de Seudoanonimización */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Dropzone */}
        <Card className="p-4 lg:col-span-7 flex flex-col justify-between">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
              Carga Múltiple de Historias Clínicas
            </span>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">Asignar archivos a:</label>
              <select
                value={targetPatientId}
                onChange={(e) => setTargetPatientId(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
              >
                <option value="__auto__">
                  Auto-agrupar por prefijo (ej. P001_Epicrisis + P001_AP)
                </option>
                <option value="__each__">Crear 1 paciente nuevo por archivo</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    Adjuntar a {p.studyCode} ({p.originalIdentifier})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files?.length) {
                handleIncomingFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition ${
              dragging
                ? "border-sky-600 bg-sky-50"
                : "border-slate-300 bg-slate-50/70 hover:border-sky-400 hover:bg-sky-50/30"
            }`}
          >
            <UploadCloud className="h-9 w-9 text-sky-700" />
            <p className="mt-2 text-sm font-medium text-slate-800">
              {parsingFiles
                ? "Leyendo documentos en este equipo..."
                : "Arrastrá múltiples archivos aquí o hacé clic para seleccionar"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Soporta PDF (con texto seleccionable), Word (.docx) y texto (.txt). Los archivos
              se procesan únicamente en tu computadora.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  handleIncomingFiles(e.target.files);
                  e.target.value = "";
                }
              }}
            />
          </div>
        </Card>

        {/* Protección de datos del paciente */}
        <Card className="p-4 lg:col-span-5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-700" />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700">
              Protección de datos del paciente
            </h3>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Oculta automáticamente DNI, nombres y teléfonos antes de analizar la historia.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {(
              [
                ["maskDni", "DNI / CUIL / Documento"],
                ["maskNames", "Nombres en encabezados"],
                ["maskRecordIds", "N° Historia Clínica / Socio"],
                ["maskPhones", "Teléfonos / Celulares"],
                ["maskEmails", "Correos electrónicos"],
                ["maskAddresses", "Domicilios / Direcciones"],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 cursor-pointer hover:bg-white"
              >
                <input
                  type="checkbox"
                  checked={Boolean(study.redactionRules[key])}
                  onChange={(e) => updateRedactionRules({ [key]: e.target.checked })}
                  className="rounded border-slate-300 text-sky-700 focus:ring-sky-500"
                />
                <span className="text-slate-700">{label}</span>
              </label>
            ))}
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] font-medium text-slate-600">
              Términos personalizados a redactar (separados por coma)
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Ej. Hospital Italiano, Dr. Pérez..."
                value={customTermsInput}
                onChange={(e) => setCustomTermsInput(e.target.value)}
                className="text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  updateRedactionRules({
                    customTerms: customTermsInput
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              >
                Aplicar
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Panel de Extracción automática de datos */}
      <Card className="p-4 border-sky-200 bg-sky-50/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-700 text-white">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Extracción automática de datos
              </h3>
              <p className="text-xs text-slate-600">
                Analiza cada historia y resalta la frase exacta de donde obtuvo cada dato.
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-sky-800">
                {activeModelSummary}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isRunningQueue ? (
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    launchExtractionQueue(
                      patients.filter(
                        (p) =>
                          p.extractionStatus === "idle" ||
                          p.extractionStatus === "error" ||
                          p.extractionStatus === "partial"
                      ),
                      { forceReextract: false }
                    )
                  }
                  disabled={patients.length === 0 || variables.length === 0}
                >
                  <Play className="h-3.5 w-3.5" />
                  Extraer Pendientes / Errores
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    launchExtractionQueue(errorPatients, { forceReextract: true })
                  }
                  disabled={errorPatients.length === 0 || variables.length === 0}
                  className={
                    errorPatients.length > 0
                      ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      : undefined
                  }
                  title="Reprocesa únicamente los pacientes con error sin modificar los ya validados"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reintentar solo errores ({errorPatients.length})
                </Button>

                {totalPendingNewColumns > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      launchExtractionQueue(patients, { missingVariablesOnly: true })
                    }
                    title="Extrae únicamente las variables nuevas agregadas después de la última corrida"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Solo Variables Nuevas ({totalPendingNewColumns})
                  </Button>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    launchExtractionQueue(patients, { forceReextract: true })
                  }
                  disabled={patients.length === 0 || variables.length === 0}
                  title="Vuelve a analizar casos no validados respetando siempre las correcciones manuales"
                >
                  Re-extraer Cohorte ({patients.length})
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    pauseRef.current = !pauseRef.current;
                    setIsPaused(pauseRef.current);
                  }}
                >
                  {isPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5" /> Reanudar
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5" /> Pausar
                    </>
                  )}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    abortRef.current = true;
                  }}
                >
                  <Square className="h-3.5 w-3.5" /> Detener
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Barra de progreso */}
        {queueProgress && (
          <div className="mt-4 space-y-2 rounded-lg border border-sky-200 bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-slate-800">
                {queueProgress.currentPatientCode
                  ? `Analizando ${queueProgress.currentPatientCode}...`
                  : "Extracción finalizada"}{" "}
                ({queueProgress.completed}/{queueProgress.total})
              </span>
              <div className="flex items-center gap-2">
                {queueProgress.lastMode && (
                  <Badge variant={queueProgress.lastMode === "gemini" ? "blue" : "amber"}>
                    {queueProgress.lastMode === "gemini"
                      ? "Extracción estructurada IA"
                      : "Modo de demostración"}
                  </Badge>
                )}
                <span className="text-emerald-700 font-medium">
                  ✓ {queueProgress.succeeded}
                </span>
                {queueProgress.partial > 0 && (
                  <span className="text-amber-700 font-medium">
                    ⚠ {queueProgress.partial}
                  </span>
                )}
                {queueProgress.failed > 0 && (
                  <span className="text-rose-600 font-medium">
                    ✕ {queueProgress.failed}
                  </span>
                )}
              </div>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-sky-700 transition-all duration-300"
                style={{
                  width: `${
                    queueProgress.total > 0
                      ? Math.round((queueProgress.completed / queueProgress.total) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>

            {queueProgress.retryMessage && (
              <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span>{queueProgress.retryMessage}</span>
              </div>
            )}
            {queueProgress.lastWarning && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                {queueProgress.lastWarning}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Lista de Pacientes y Documentos Agrupados */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">
            Cohorte Cargada ({patients.length} pacientes · {documents.length} documentos)
          </h3>
          {patients.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => onGoToValidation()}>
              Ir a Paso 3: Revisar y validar casos →
            </Button>
          )}
        </div>

        {patients.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-700">
              Aún no hay historias clínicas cargadas en este estudio.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Arrastra archivos PDF/DOCX/TXT arriba, pega una historia clínica manualmente o
              carga el Estudio de Ejemplo desde la barra superior.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {patients.map((patient) => {
              const pDocs = docsByPatient.get(patient.id) || [];
              const missingCols = missingColsByPatient.get(patient.id) ?? 0;
              const scannedDocs = pDocs.filter((d) => isDocumentLowTextPdf(d));
              const formattedError = formatStoredErrorForDisplay(
                patient.extractionError,
                patient.extractionErrorDetail
              );

              return (
                <div key={patient.id} className="p-4 hover:bg-slate-50/60">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="rounded-md bg-slate-900 px-2.5 py-1 font-mono text-xs font-semibold text-white">
                        {patient.studyCode}
                      </span>
                      <span className="text-xs text-slate-500">
                        Ref. local:{" "}
                        <strong className="font-medium text-slate-700">
                          {patient.originalIdentifier}
                        </strong>
                      </span>

                      {patient.extractionStatus === "done" && (
                        <Badge variant="green">
                          <CheckCircle2 className="h-3 w-3" />
                          Extraído
                        </Badge>
                      )}
                      {patient.extractionStatus === "partial" && (
                        <Badge variant="amber">
                          <AlertTriangle className="h-3 w-3" />
                          Extracción parcial
                        </Badge>
                      )}
                      {patient.extractionStatus === "processing" && (
                        <Badge variant="blue">Analizando...</Badge>
                      )}
                      {patient.extractionStatus === "queued" && (
                        <Badge variant="slate">En espera</Badge>
                      )}
                      {patient.extractionStatus === "idle" && (
                        <Badge variant="amber">Pendiente de extracción</Badge>
                      )}
                      {patient.extractionStatus === "error" && (
                        <Badge variant="red">No completado</Badge>
                      )}
                      {patient.validationStatus === "validated" && (
                        <Badge variant="green">Validado (protegido)</Badge>
                      )}
                      {missingCols > 0 && patient.lastExtractedAt && (
                        <Badge variant="purple">
                          +{missingCols} variable(s) nueva(s) sin extraer
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={isRunningQueue || variables.length === 0}
                        onClick={() =>
                          launchExtractionQueue([patient], {
                            forceReextract: Boolean(patient.lastExtractedAt),
                          })
                        }
                      >
                        <Cpu className="h-3 w-3" />
                        {patient.lastExtractedAt ? "Re-extraer" : "Extraer"}
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => onGoToValidation(patient.id)}
                      >
                        Revisar
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleDeletePatient(patient)}
                        className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                        title="Eliminar paciente"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Alerta clara si algún PDF del paciente parece escaneado sin texto seleccionable */}
                  {scannedDocs.length > 0 && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                      <div>
                        <p className="font-semibold">{SCANNED_PDF_WARNING}</p>
                        <p className="mt-0.5 text-[11px] text-amber-800">
                          Archivo(s):{" "}
                          <strong>{scannedDocs.map((d) => d.filename).join(", ")}</strong>. El
                          documento original se conservó, pero no se realizó reconocimiento de
                          texto (OCR) ni se enviará texto vacío a la IA.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error en español humano con detalle técnico colapsable */}
                  {formattedError && (
                    <div
                      className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                        patient.extractionStatus === "partial"
                          ? "border-amber-200 bg-amber-50 text-amber-900"
                          : "border-rose-200 bg-rose-50 text-rose-800"
                      }`}
                    >
                      <p className="font-medium">{formattedError.userMessage}</p>
                      {formattedError.technicalDetail && (
                        <details className="mt-1.5 text-[11px]">
                          <summary className="cursor-pointer font-medium opacity-80 hover:opacity-100 select-none">
                            Ver detalle técnico
                          </summary>
                          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-white/70 p-2 font-mono text-[10px] text-slate-700 border border-slate-200">
                            {formattedError.technicalDetail}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}

                  {/* Documentos agrupados del paciente */}
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {pDocs.map((doc) => {
                      const docLowText = isDocumentLowTextPdf(doc);
                      return (
                      <div
                        key={doc.id}
                        className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
                          docLowText
                            ? "border-amber-300 bg-amber-50/40"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <FileText
                              className={`h-3.5 w-3.5 shrink-0 ${
                                docLowText ? "text-amber-600" : "text-sky-700"
                              }`}
                            />
                            <span className="truncate font-medium text-slate-800">
                              {doc.filename}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                            <span>{DOCUMENT_CATEGORY_LABELS[doc.category]}</span>
                            <span>·</span>
                            {docLowText ? (
                              <Badge variant="amber" className="text-[10px] py-0">
                                Sin texto seleccionable
                              </Badge>
                            ) : (
                              <span
                                className={
                                  doc.redactionCount > 0
                                    ? "text-emerald-700 font-medium"
                                    : "text-slate-500"
                                }
                              >
                                {doc.redactionCount} dato(s) oculto(s)
                              </span>
                            )}
                            {doc.redactionConfirmed && (
                              <Badge variant="green" className="text-[10px] py-0">
                                Confirmado
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => setPreviewDoc(doc)}
                            className="rounded p-1 text-slate-500 hover:bg-sky-50 hover:text-sky-700 cursor-pointer"
                            title="Vista previa del texto protegido"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteDocument(doc)}
                            className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                            title="Eliminar documento"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => {
                        setPasteTargetPatientId(patient.id);
                        setPasteFilename(`${patient.studyCode}_Anexo.txt`);
                        setPasteModalOpen(true);
                      }}
                      className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500 hover:border-sky-400 hover:bg-sky-50/40 hover:text-sky-700 cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Agregar otro informe a {patient.studyCode}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Modal: Pegar texto clínico */}
      <Modal
        open={pasteModalOpen}
        onClose={() => setPasteModalOpen(false)}
        title="Pegar Texto de Historia Clínica"
        subtitle="El texto se procesa y seudoanonimiza localmente antes de enviarse a Gemini."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSavePastedText} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Asignar a paciente
              </label>
              <Select
                value={pasteTargetPatientId}
                onChange={(e) => setPasteTargetPatientId(e.target.value)}
              >
                <option value="__new__">+ Crear nuevo paciente seudoanonimizado</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.studyCode} — {p.originalIdentifier}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Tipo de documento
              </label>
              <Select
                value={pasteCategory}
                onChange={(e) => setPasteCategory(e.target.value as DocumentCategory)}
              >
                {Object.entries(DOCUMENT_CATEGORY_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pasteTargetPatientId === "__new__" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Identificador local para Tabla Llave (opcional)
                </label>
                <Input
                  placeholder="Ej. HC-104922 (nunca se envía a la IA)"
                  value={pasteOrigId}
                  onChange={(e) => setPasteOrigId(e.target.value)}
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Nombre del documento
              </label>
              <Input
                value={pasteFilename}
                onChange={(e) => setPasteFilename(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Texto clínico (evolución, epicrisis, anatomía patológica, imágenes...) *
            </label>
            <Textarea
              required
              rows={9}
              placeholder="Pega aquí el contenido textual de la historia clínica..."
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              className="font-mono text-xs leading-relaxed"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setPasteModalOpen(false)}
            >
              Cancelar
            </Button>
            <Button type="submit">Guardar y proteger datos</Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Advertencia de Archivos Duplicados */}
      <Modal
        open={Boolean(pendingDuplicates)}
        onClose={() => setPendingDuplicates(null)}
        title="Posibles Documentos Duplicados Detectados"
        subtitle="Para evitar pacientes duplicados en la cohorte, revisa las coincidencias detectadas en este estudio."
        maxWidth="max-w-2xl"
      >
        {pendingDuplicates && (
          <div className="space-y-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
              <div>
                Se detectaron{" "}
                <strong>{pendingDuplicates.duplicates.length} archivo(s)</strong> que
                coinciden por nombre o tamaño exacto con documentos ya existentes en el
                estudio actual.
              </div>
            </div>

            <div className="max-h-60 space-y-2 overflow-y-auto">
              {pendingDuplicates.duplicates.map((dup, idx) => (
                <div
                  key={`${dup.file.name}-${idx}`}
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">{dup.file.name}</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {formatFileSize(dup.file.size)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {dup.reasons.map((r) => (
                      <Badge key={r} variant="amber">
                        {r}
                      </Badge>
                    ))}
                    <span className="text-[11px] text-slate-600">
                      Coincide con{" "}
                      <strong className="font-mono">{dup.existingDocName}</strong> (
                      {dup.existingPatientCode})
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-200">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPendingDuplicates(null)}
              >
                Cancelar carga
              </Button>
              {pendingDuplicates.nonDuplicates.length > 0 && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const toUpload = pendingDuplicates.nonDuplicates;
                    setPendingDuplicates(null);
                    void processUploadedFiles(toUpload);
                  }}
                >
                  Omitir duplicados y subir solo nuevos (
                  {pendingDuplicates.nonDuplicates.length})
                </Button>
              )}
              <Button
                type="button"
                variant={
                  pendingDuplicates.nonDuplicates.length > 0 ? "outline" : "danger"
                }
                size="sm"
                onClick={() => {
                  const toUpload = pendingDuplicates.allFiles;
                  setPendingDuplicates(null);
                  void processUploadedFiles(toUpload);
                }}
              >
                Subir todos de todas formas ({pendingDuplicates.allFiles.length})
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal: Vista Previa de Seudoanonimización */}
      <Modal
        open={Boolean(previewDoc)}
        onClose={() => setPreviewDoc(null)}
        title={`Vista Previa de Seudoanonimización — ${previewDoc?.filename ?? ""}`}
        subtitle="Verifica que no permanezcan datos filiatorios antes de correr la extracción IA."
        maxWidth="max-w-4xl"
      >
        {previewDoc && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-700">
                  Elementos redactados ({previewDoc.redactionCount}):
                </span>
                {Object.keys(previewDoc.redactionSummary).length === 0 ? (
                  <span className="text-slate-500">
                    No se detectaron patrones filiatorios automáticos
                  </span>
                ) : (
                  Object.entries(previewDoc.redactionSummary).map(([k, count]) => (
                    <Badge key={k} variant="amber">
                      {k}: {count}
                    </Badge>
                  ))
                )}
              </div>

              <Button
                size="xs"
                variant={previewDoc.redactionConfirmed ? "success" : "primary"}
                onClick={() => handleConfirmRedaction(previewDoc)}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {previewDoc.redactionConfirmed
                  ? "Redacción Confirmada"
                  : "Confirmar Texto Redactado"}
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">
                  Texto Original (solo local)
                </p>
                <pre className="h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700">
                  {previewDoc.rawText}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-emerald-800">
                  Texto Redactado (el que recibirá la IA)
                </p>
                <pre className="h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg border border-emerald-200 bg-emerald-50/30 p-3 font-mono text-xs leading-relaxed text-slate-800">
                  {previewDoc.redactedText}
                </pre>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
