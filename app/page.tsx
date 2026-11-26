"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Activity,
  CheckCircle2,
  FlaskConical,
  FolderPlus,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { createStudy, db } from "@/lib/db";
import { seedDemoStudy } from "@/lib/templates";
import type {
  ClinicalDocument,
  ExtractionRecord,
  Patient,
  Study,
  StudyVariable,
} from "@/lib/types";
import { AppSidebar, type ActiveStepId } from "@/components/layout/AppSidebar";
import { StudyHeader } from "@/components/layout/StudyHeader";
import { CodebookModule } from "@/components/codebook/CodebookModule";
import { IngestionModule } from "@/components/ingestion/IngestionModule";
import { ValidationWorkspace } from "@/components/validation/ValidationWorkspace";
import { AnalyticsExportModule } from "@/components/analytics/AnalyticsExportModule";
import { Button, Card } from "@/components/ui/primitives";

interface ToastMessage {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export default function HomePage() {
  const [activeStudyId, setActiveStudyId] = useState<string>("");
  const [activeStep, setActiveStep] = useState<ActiveStepId>("codebook");
  const [focusedPatientId, setFocusedPatientId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [loadingDemo, setLoadingDemo] = useState(false);

  const studies = useLiveQuery(
    () => db.studies.orderBy("createdAt").reverse().toArray(),
    [],
    [] as Study[]
  );

  useEffect(() => {
    if (studies.length > 0 && !studies.some((s) => s.id === activeStudyId)) {
      setActiveStudyId(studies[0].id);
    } else if (studies.length === 0 && activeStudyId !== "") {
      setActiveStudyId("");
    }
  }, [studies, activeStudyId]);

  const activeStudy = useMemo(
    () => studies.find((s) => s.id === activeStudyId) ?? null,
    [studies, activeStudyId]
  );

  const variables = useLiveQuery(
    async (): Promise<StudyVariable[]> =>
      activeStudyId
        ? db.variables.where("studyId").equals(activeStudyId).sortBy("order")
        : [],
    [activeStudyId],
    [] as StudyVariable[]
  );

  const patients = useLiveQuery(
    async (): Promise<Patient[]> =>
      activeStudyId
        ? db.patients.where("studyId").equals(activeStudyId).sortBy("studyCode")
        : [],
    [activeStudyId],
    [] as Patient[]
  );

  const documents = useLiveQuery(
    async (): Promise<ClinicalDocument[]> =>
      activeStudyId
        ? db.documents.where("studyId").equals(activeStudyId).toArray()
        : [],
    [activeStudyId],
    [] as ClinicalDocument[]
  );

  const extractions = useLiveQuery(
    async (): Promise<ExtractionRecord[]> =>
      activeStudyId
        ? db.extractions.where("studyId").equals(activeStudyId).toArray()
        : [],
    [activeStudyId],
    [] as ExtractionRecord[]
  );

  function notify(text: string, tone: "info" | "success" | "error" = "info") {
    const id = Date.now();
    setToast({ id, text, tone });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 5200);
  }

  async function handleQuickDemo() {
    setLoadingDemo(true);
    try {
      const demo = await seedDemoStudy();
      setActiveStudyId(demo.id);
      setActiveStep("validation");
      notify(
        "Estudio de ejemplo cargado con 12 variables y 3 casos ficticios listos para auditar.",
        "success"
      );
    } finally {
      setLoadingDemo(false);
    }
  }

  async function handleQuickNewStudy() {
    const created = await createStudy({
      name: "Nuevo Estudio Oncológico Retrospectivo",
      description: "Cohorte observacional retrospectiva institucional.",
      codePrefix: "EST01",
    });
    setActiveStudyId(created.id);
    setActiveStep("codebook");
    notify("Estudio creado. Comienza cargando variables o una plantilla oncológica.", "success");
  }

  const sidebarCounts = useMemo(
    () => ({
      variables: variables.length,
      patients: patients.length,
      validated: patients.filter((p) => p.validationStatus === "validated").length,
      documents: documents.length,
    }),
    [variables.length, patients, documents.length]
  );

  return (
    <div className="flex min-h-screen flex-col lg:flex-row bg-slate-50">
      <AppSidebar
        activeStep={activeStep}
        onSelectStep={(step) => setActiveStep(step)}
        counts={sidebarCounts}
        disabled={!activeStudy}
      />

      <div className="flex flex-1 flex-col min-w-0">
        <StudyHeader
          studies={studies}
          activeStudy={activeStudy}
          onSelectStudy={(id) => {
            setActiveStudyId(id);
            setFocusedPatientId(null);
          }}
          onStudyChanged={(newId) => {
            if (newId) setActiveStudyId(newId);
            setFocusedPatientId(null);
          }}
          onNotify={notify}
        />

        {/* Notificación flotante */}
        {toast && (
          <div className="fixed bottom-5 right-5 z-50 max-w-md animate-in fade-in slide-in-from-bottom-2">
            <div
              className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-xs font-medium shadow-lg ${
                toast.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : toast.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-900"
                    : "border-sky-200 bg-sky-50 text-sky-900"
              }`}
            >
              {toast.tone === "success" && (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
              )}
              {toast.tone === "error" && (
                <XCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
              )}
              {toast.tone === "info" && (
                <Sparkles className="h-4 w-4 shrink-0 text-sky-600 mt-0.5" />
              )}
              <span>{toast.text}</span>
            </div>
          </div>
        )}

        <main className="flex-1 p-5 lg:p-6">
          {!activeStudy ? (
            <div className="mx-auto max-w-3xl py-10">
              <Card className="p-8 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
                  <Activity className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-2xl font-bold text-slate-900">
                  Plataforma de Extracción de Datos Clínicos para Oncología
                </h2>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-600">
                  Transforma historias clínicas no estructuradas (PDF, DOCX, TXT) en bases de
                  datos estructuradas, seudoanonimizadas y auditables con trazabilidad
                  verbatim, listas para análisis en R, SPSS, Jamovi o Stata.
                </p>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <Button size="lg" onClick={handleQuickDemo} disabled={loadingDemo}>
                    <FlaskConical className="h-4 w-4" />
                    {loadingDemo
                      ? "Cargando estudio de ejemplo..."
                      : "Cargar Estudio de Ejemplo (12 vars · 3 HCD)"}
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={handleQuickNewStudy}
                  >
                    <FolderPlus className="h-4 w-4" />
                    Crear Nuevo Estudio Vacío
                  </Button>
                </div>

                <div className="mt-8 grid grid-cols-1 gap-3 text-left sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <p className="text-xs font-semibold text-slate-900">
                      1. Rigor Científico
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      JSON Schema estricto + prohibición de inferencia: cada dato incluye cita
                      textual exacta y semáforo de confianza.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <p className="text-xs font-semibold text-slate-900 flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      2. Privacidad Local-First
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Tus estudios viven en IndexedDB. El filtro redacta DNI, nombres y HC
                      antes de invocar a Gemini.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <p className="text-xs font-semibold text-slate-900">
                      3. Listo para Publicar
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Calcula intervalos Kaplan-Meier y exporta Excel de 3 hojas (Base +
                      Diccionario + Auditoría IA) o CSV UTF-8.
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          ) : (
            <div className="mx-auto max-w-[1440px]">
              {activeStep === "codebook" && (
                <CodebookModule
                  study={activeStudy}
                  variables={variables}
                  onNotify={notify}
                  onGoNextStep={() => setActiveStep("ingestion")}
                />
              )}

              {activeStep === "ingestion" && (
                <IngestionModule
                  study={activeStudy}
                  variables={variables}
                  patients={patients}
                  documents={documents}
                  extractions={extractions}
                  onNotify={notify}
                  onGoToValidation={(pid) => {
                    if (pid) setFocusedPatientId(pid);
                    setActiveStep("validation");
                  }}
                />
              )}

              {activeStep === "validation" && (
                <ValidationWorkspace
                  study={activeStudy}
                  variables={variables}
                  patients={patients}
                  documents={documents}
                  extractions={extractions}
                  initialPatientId={focusedPatientId}
                  onNotify={notify}
                  onGoToIngestion={() => setActiveStep("ingestion")}
                />
              )}

              {activeStep === "analytics" && (
                <AnalyticsExportModule
                  study={activeStudy}
                  variables={variables}
                  patients={patients}
                  extractions={extractions}
                  onNotify={notify}
                  onOpenValidation={(pid) => {
                    setFocusedPatientId(pid);
                    setActiveStep("validation");
                  }}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
