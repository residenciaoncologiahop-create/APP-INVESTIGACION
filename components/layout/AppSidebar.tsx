"use client";

import React from "react";
import {
  Activity,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/components/ui/primitives";

export type ActiveStepId = "codebook" | "ingestion" | "validation" | "analytics";

interface AppSidebarProps {
  activeStep: ActiveStepId;
  onSelectStep: (step: ActiveStepId) => void;
  counts: {
    variables: number;
    patients: number;
    validated: number;
    documents: number;
  };
  disabled?: boolean;
}

export function AppSidebar({
  activeStep,
  onSelectStep,
  counts,
  disabled,
}: AppSidebarProps) {
  const steps: Array<{
    id: ActiveStepId;
    num: string;
    title: string;
    subtitle: string;
    badge: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      id: "codebook",
      num: "1",
      title: "Variables del estudio",
      subtitle: "Datos a recolectar",
      badge: `${counts.variables} vars`,
      icon: BookOpen,
    },
    {
      id: "ingestion",
      num: "2",
      title: "Cargar historias clínicas",
      subtitle: "Protección y extracción",
      badge: `${counts.patients} pac.`,
      icon: UploadCloud,
    },
    {
      id: "validation",
      num: "3",
      title: "Revisar y validar casos",
      subtitle: "Revisión médica asistida",
      badge: `${counts.validated}/${counts.patients}`,
      icon: ClipboardCheck,
    },
    {
      id: "analytics",
      num: "4",
      title: "Base y Casuística",
      subtitle: "Planilla, estadísticas y Excel",
      badge: "Excel/CSV",
      icon: BarChart3,
    },
  ];

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-slate-900 text-slate-100 lg:w-64 lg:min-h-screen lg:border-b-0 lg:border-r">
      {/* Marca */}
      <div className="flex items-center gap-2.5 border-b border-slate-800 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white shadow-sm">
          <Activity className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight text-white">
            OncoData Extract
          </h1>
          <p className="text-[11px] text-slate-400">
            Investigación Oncológica IA
          </p>
        </div>
      </div>

      {/* Flujo guiado paso a paso */}
      <nav className="flex-1 space-y-1 p-3">
        <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Flujo de Investigación
        </p>

        {steps.map((step) => {
          const Icon = step.icon;
          const isActive = activeStep === step.id;
          return (
            <button
              key={step.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelectStep(step.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
                isActive
                  ? "bg-sky-700 text-white shadow-sm"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              )}
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-mono font-bold",
                  isActive
                    ? "bg-white/20 text-white"
                    : "bg-slate-800 text-slate-300"
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold leading-tight">
                    {step.num}. {step.title}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]",
                      isActive
                        ? "bg-sky-900/60 text-sky-100"
                        : "bg-slate-800 text-slate-400"
                    )}
                  >
                    {step.badge}
                  </span>
                </div>
                <p
                  className={cn(
                    "truncate text-[11px]",
                    isActive ? "text-sky-100" : "text-slate-400"
                  )}
                >
                  {step.subtitle}
                </p>
              </div>
            </button>
          );
        })}
      </nav>

      {/* Pie de privacidad */}
      <div className="border-t border-slate-800 p-4 text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5 font-medium text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          Guardado en este equipo
        </div>
        <p className="mt-1 leading-relaxed">
          Tus estudios permanecen en este equipo. Los datos identificatorios del paciente se
          ocultan antes de analizar la historia clínica.
        </p>
      </div>
    </aside>
  );
}
