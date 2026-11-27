"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FlaskConical,
  FolderPlus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  WifiOff,
} from "lucide-react";
import {
  createStudy,
  deleteStudyCascade,
  exportStudyBackup,
  getAppSettings,
  importStudyBackup,
  saveAppSettings,
} from "@/lib/db";
import { downloadJsonFile } from "@/lib/exporters";
import { seedDemoStudy } from "@/lib/templates";
import type {
  AppSettingsState,
  GeminiModel,
  ModelsDiscoveryResponse,
  Study,
  StudyBackupPayload,
} from "@/lib/types";
import { Badge, Button, Input, Modal, Select, Textarea } from "@/components/ui/primitives";

interface StudyHeaderProps {
  studies: Study[];
  activeStudy: Study | null;
  onSelectStudy: (studyId: string) => void;
  onStudyChanged: (newStudyId?: string) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
  modelsDiscovery: ModelsDiscoveryResponse | null;
  checkingModels: boolean;
  demoModeEnabled: boolean;
  onRefreshAiStatus: (manualKeyOverride?: string) => Promise<ModelsDiscoveryResponse>;
}

export function StudyHeader({
  studies,
  activeStudy,
  onSelectStudy,
  onStudyChanged,
  onNotify,
  modelsDiscovery,
  checkingModels,
  demoModeEnabled,
  onRefreshAiStatus,
}: StudyHeaderProps) {
  const [newStudyOpen, setNewStudyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [studyName, setStudyName] = useState("");
  const [studyDesc, setStudyDesc] = useState("");
  const [codePrefix, setCodePrefix] = useState("ONCO");
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const [settings, setSettings] = useState<AppSettingsState>({
    geminiApiKey: "",
    defaultModel: "",
    fallbackModel: "",
    customModel: "",
    rateLimitDelayMs: 750,
    useDemoMode: false,
  });

  const backupInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAppSettings().then(setSettings).catch(() => {});
  }, [settingsOpen]);

  async function handleCreateStudy(e: React.FormEvent) {
    e.preventDefault();
    if (!studyName.trim()) return;
    const created = await createStudy({
      name: studyName,
      description: studyDesc,
      codePrefix: codePrefix || "ONCO",
    });
    setStudyName("");
    setStudyDesc("");
    setCodePrefix("ONCO");
    setNewStudyOpen(false);
    onStudyChanged(created.id);
    onNotify(`Estudio "${created.name}" creado correctamente.`, "success");
  }

  async function handleSeedDemo() {
    setLoadingDemo(true);
    try {
      const demo = await seedDemoStudy();
      onStudyChanged(demo.id);
      onNotify(
        "Estudio de ejemplo cargado: 12 variables y 3 historias clínicas ficticias listas para explorar.",
        "success"
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "No se pudo cargar el estudio de ejemplo.",
        "error"
      );
    } finally {
      setLoadingDemo(false);
    }
  }

  async function handleDeleteStudy() {
    if (!activeStudy) return;
    const ok = window.confirm(
      `¿Eliminar permanentemente el estudio "${activeStudy.name}" junto con sus variables, historias clínicas y resultados guardados en este equipo?`
    );
    if (!ok) return;
    await deleteStudyCascade(activeStudy.id);
    onStudyChanged(undefined);
    onNotify(`Estudio "${activeStudy.name}" eliminado.`, "info");
  }

  async function handleExportBackup() {
    if (!activeStudy) return;
    const payload = await exportStudyBackup(activeStudy.id);
    downloadJsonFile(
      payload,
      `respaldo_${activeStudy.codePrefix.toLowerCase()}_${new Date()
        .toISOString()
        .slice(0, 10)}.json`
    );
    onNotify("Respaldo completo del estudio descargado en tu equipo.", "success");
  }

  async function handleImportBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as StudyBackupPayload;
      const imported = await importStudyBackup(parsed);
      onStudyChanged(imported.id);
      onNotify(`Respaldo "${imported.name}" importado en este equipo.`, "success");
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "No se pudo importar el archivo de respaldo.",
        "error"
      );
    } finally {
      e.target.value = "";
    }
  }

  async function handleToggleDemoMode(checked: boolean) {
    setSettings((prev) => ({ ...prev, useDemoMode: checked }));
    await saveAppSettings({ useDemoMode: checked });
    await onRefreshAiStatus();
    onNotify(
      checked
        ? "Modo de demostración activado (sin conexión a IA)."
        : "Modo de demostración desactivado.",
      "info"
    );
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await saveAppSettings(settings);
      const updated = await getAppSettings();
      setSettings(updated);
      const discovery = await onRefreshAiStatus(updated.geminiApiKey);
      if (updated.useDemoMode) {
        onNotify("Configuración guardada. La aplicación está en modo de demostración.", "info");
      } else if (discovery.authenticated && discovery.connectionStatus === "connected") {
        onNotify("Configuración guardada y conexión con la IA verificada.", "success");
      } else if (discovery.connectionStatus === "not_configured") {
        onNotify("Configuración guardada. No hay una clave de IA configurada.", "info");
      } else {
        onNotify(
          discovery.error || "Configuración guardada, pero no se pudo verificar la conexión con la IA.",
          "error"
        );
      }
    } finally {
      setSavingSettings(false);
    }
  }

  // Determinar estado visual claro de los 4 estados posibles de conexión IA
  const aiStatusView = (() => {
    if (demoModeEnabled) {
      return {
        variant: "purple" as const,
        badgeText: "Modo de demostración",
        title: "Modo de demostración activo",
        description:
          "Las extracciones se simulan localmente con ejemplos sin usar el servicio de IA.",
      };
    }
    if (checkingModels && !modelsDiscovery) {
      return {
        variant: "slate" as const,
        badgeText: "Verificando IA...",
        title: "Verificando conexión con la IA",
        description: "Comprobando disponibilidad de modelos...",
      };
    }
    if (modelsDiscovery?.authenticated && modelsDiscovery.connectionStatus === "connected") {
      const selectedId =
        settings.customModel.trim() ||
        settings.defaultModel.trim() ||
        modelsDiscovery.recommendedModel ||
        "";
      const matchedModel = modelsDiscovery.models.find((m) => m.id === selectedId);
      const modelLabel = matchedModel?.displayName || selectedId || "Automático";
      return {
        variant: "green" as const,
        badgeText: "IA conectada y verificada",
        title: "IA conectada y verificada",
        description: `Lista para analizar historias clínicas. Modelo activo: ${modelLabel}.`,
      };
    }
    if (modelsDiscovery?.connectionStatus === "configured_disconnected") {
      return {
        variant: "red" as const,
        badgeText: "IA configurada sin conexión",
        title: "IA configurada pero sin conexión",
        description:
          modelsDiscovery.error ||
          "Hay una clave configurada, pero no se pudo establecer conexión con el servicio de IA.",
      };
    }
    return {
      variant: "amber" as const,
      badgeText: "IA no configurada",
      title: "IA no configurada",
      description:
        "Todavía no hay una clave de acceso configurada. Podés agregar una en Configuración técnica avanzada o activar el modo de demostración.",
    };
  })();

  const availableModels = modelsDiscovery?.models ?? [];

  return (
    <>
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-500">Estudio activo:</label>
            <select
              value={activeStudy?.id ?? ""}
              onChange={(e) => onSelectStudy(e.target.value)}
              className="max-w-[320px] rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-sm font-medium text-slate-900 focus:border-sky-600 focus:bg-white focus:outline-none"
              disabled={studies.length === 0}
            >
              {studies.length === 0 ? (
                <option value="">Sin estudios creados</option>
              ) : (
                studies.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.codePrefix}] {s.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setNewStudyOpen(true)}
          >
            <FolderPlus className="h-3.5 w-3.5 text-sky-700" />
            Nuevo Estudio
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSeedDemo}
            disabled={loadingDemo}
            className="border-sky-200 bg-sky-50/70 text-sky-800 hover:bg-sky-100"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            {loadingDemo ? "Cargando..." : "Cargar Estudio de Ejemplo"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={aiStatusView.variant}>
            {aiStatusView.variant === "green" && <CheckCircle2 className="h-3 w-3" />}
            {aiStatusView.variant === "red" && <WifiOff className="h-3 w-3" />}
            {aiStatusView.variant === "amber" && <AlertTriangle className="h-3 w-3" />}
            {aiStatusView.variant === "purple" && <FlaskConical className="h-3 w-3" />}
            {aiStatusView.badgeText}
          </Badge>

          <Badge variant="slate" className="hidden sm:inline-flex">
            <ShieldCheck className="h-3 w-3 text-emerald-600" />
            Guardado en este equipo
          </Badge>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAdvancedOpen(false);
              setSettingsOpen(true);
            }}
            title="Ver estado de la IA y respaldar el estudio"
          >
            <Settings className="h-3.5 w-3.5" />
            Configuración y Respaldo
          </Button>
        </div>
      </header>

      {/* Modal: Nuevo Estudio */}
      <Modal
        open={newStudyOpen}
        onClose={() => setNewStudyOpen(false)}
        title="Crear Nuevo Estudio Retrospectivo"
        subtitle="Cada estudio mantiene separadas sus variables, historias clínicas y resultados."
      >
        <form onSubmit={handleCreateStudy} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Nombre del estudio *
            </label>
            <Input
              required
              placeholder="Ej. Cohorte Retrospectiva Cáncer de Pulmón E-IV"
              value={studyName}
              onChange={(e) => setStudyName(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Prefijo de código de paciente *
            </label>
            <Input
              required
              maxLength={8}
              placeholder="Ej. PULM, TNE, MAMA"
              value={codePrefix}
              onChange={(e) => setCodePrefix(e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Los pacientes recibirán códigos automáticos como{" "}
              <code className="font-mono font-semibold text-slate-700">
                {(codePrefix || "EST01").toUpperCase()}-001
              </code>
              ,{" "}
              <code className="font-mono font-semibold text-slate-700">
                {(codePrefix || "EST01").toUpperCase()}-002
              </code>
              .
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Objetivo / Criterios de inclusión (opcional)
            </label>
            <Textarea
              rows={3}
              placeholder="Descripción breve de la cohorte, período de inclusión o protocolo institucional..."
              value={studyDesc}
              onChange={(e) => setStudyDesc(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewStudyOpen(false)}
            >
              Cancelar
            </Button>
            <Button type="submit">Crear Estudio</Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Configuración y Respaldo */}
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Configuración y Respaldo"
        subtitle="Todos los datos del estudio se guardan únicamente en este equipo."
      >
        <div className="space-y-5">
          {/* 1. Estado de conexión de la IA (visible arriba) */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Estado de la IA
                  </span>
                  <Badge variant={aiStatusView.variant}>{aiStatusView.badgeText}</Badge>
                </div>
                <p className="text-xs text-slate-600">{aiStatusView.description}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={checkingModels}
                onClick={async () => {
                  const res = await onRefreshAiStatus();
                  if (res.authenticated && res.connectionStatus === "connected") {
                    onNotify(
                      `Conexión verificada (${res.models.length} modelos disponibles).`,
                      "success"
                    );
                  } else if (res.connectionStatus === "not_configured") {
                    onNotify("No se encontró ninguna clave de acceso configurada.", "info");
                  } else {
                    onNotify(res.error || "No se pudo conectar con la IA.", "error");
                  }
                }}
              >
                <RefreshCw className={`h-3 w-3 ${checkingModels ? "animate-spin" : ""}`} />
                Verificar conexión
              </Button>
            </div>

            {modelsDiscovery?.technicalDetail &&
              modelsDiscovery.connectionStatus === "configured_disconnected" &&
              !demoModeEnabled && (
                <details className="rounded border border-rose-200 bg-rose-50/70 px-2.5 py-1.5 text-[11px] text-rose-800">
                  <summary className="cursor-pointer font-medium select-none">
                    Ver detalle técnico
                  </summary>
                  <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-[10px] text-rose-900">
                    {modelsDiscovery.technicalDetail}
                  </pre>
                </details>
              )}

            <label className="flex items-center gap-2 pt-1 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.useDemoMode}
                onChange={(e) => void handleToggleDemoMode(e.target.checked)}
                className="rounded border-slate-300 text-sky-700 focus:ring-sky-500"
              />
              <span>Usar modo de demostración (probar el flujo sin conectar la IA)</span>
            </label>
          </div>

          {/* 2. Respaldo del estudio (visible arriba) */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-700">
              <Database className="h-3.5 w-3.5 text-sky-700" />
              Respaldo del estudio
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Guardá una copia completa del estudio activo (variables, historias clínicas y
              validaciones) en tu computadora o importá un respaldo previo.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExportBackup}
                disabled={!activeStudy}
              >
                <Download className="h-3.5 w-3.5" />
                Exportar respaldo del estudio
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => backupInputRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
                Importar respaldo del estudio
              </Button>
              <input
                ref={backupInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportBackup}
              />

              {activeStudy && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDeleteStudy}
                  className="ml-auto text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Eliminar estudio
                </Button>
              )}
            </div>
          </div>

          {/* 3. Configuración técnica avanzada (cerrada por defecto) */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <span>Configuración técnica avanzada</span>
              {advancedOpen ? (
                <ChevronDown className="h-4 w-4 text-slate-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-slate-400" />
              )}
            </button>

            {advancedOpen && (
              <form
                onSubmit={handleSaveSettings}
                className="space-y-4 border-t border-slate-200 p-4"
              >
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Clave manual de Google Gemini (opcional)
                  </label>
                  <Input
                    type="password"
                    placeholder={
                      modelsDiscovery?.hasServerKey
                        ? "Dejar vacío para usar la clave configurada en este equipo"
                        : "Pegá tu clave de acceso de Google AI Studio"
                    }
                    value={settings.geminiApiKey}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, geminiApiKey: e.target.value }))
                    }
                    className="font-mono text-xs"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    {modelsDiscovery?.hasServerKey
                      ? "Este equipo ya tiene una clave configurada en el servidor local. Completá este campo solo si querés usar otra clave."
                      : "Se guarda únicamente en este navegador y nunca se muestra a otros usuarios."}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      Modelo principal
                    </label>
                    <Select
                      value={settings.defaultModel}
                      onChange={(e) =>
                        setSettings((prev) => ({
                          ...prev,
                          defaultModel: e.target.value as GeminiModel,
                        }))
                      }
                    >
                      <option value="">
                        Automático
                        {modelsDiscovery?.recommendedModel
                          ? ` (${modelsDiscovery.recommendedModel})`
                          : ""}
                      </option>
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName} ({m.id})
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-700">
                      Modelo de respaldo
                    </label>
                    <Select
                      value={settings.fallbackModel}
                      onChange={(e) =>
                        setSettings((prev) => ({
                          ...prev,
                          fallbackModel: e.target.value as GeminiModel,
                        }))
                      }
                    >
                      <option value="">
                        Automático
                        {modelsDiscovery?.fallbackModel
                          ? ` (${modelsDiscovery.fallbackModel})`
                          : ""}
                      </option>
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName} ({m.id})
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Pausa entre pacientes (ms)
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={100}
                    value={settings.rateLimitDelayMs}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        rateLimitDelayMs: Number(e.target.value) || 0,
                      }))
                    }
                    className="font-mono text-xs"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Tiempo breve de espera entre historias clínicas para evitar saturar el
                    servicio de IA.
                  </p>
                </div>

                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={savingSettings}>
                    {savingSettings ? "Guardando y verificando..." : "Guardar configuración"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
