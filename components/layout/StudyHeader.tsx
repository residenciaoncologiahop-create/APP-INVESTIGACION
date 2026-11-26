"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Database,
  Download,
  FlaskConical,
  FolderPlus,
  KeyRound,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
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
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_PRESETS,
  normalizeGeminiModel,
  type AppSettingsState,
  type GeminiModel,
  type Study,
  type StudyBackupPayload,
} from "@/lib/types";
import { Badge, Button, Input, Modal, Select, Textarea } from "@/components/ui/primitives";

interface StudyHeaderProps {
  studies: Study[];
  activeStudy: Study | null;
  onSelectStudy: (studyId: string) => void;
  onStudyChanged: (newStudyId?: string) => void;
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
}

export function StudyHeader({
  studies,
  activeStudy,
  onSelectStudy,
  onStudyChanged,
  onNotify,
}: StudyHeaderProps) {
  const [newStudyOpen, setNewStudyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [studyName, setStudyName] = useState("");
  const [studyDesc, setStudyDesc] = useState("");
  const [codePrefix, setCodePrefix] = useState("ONCO");
  const [loadingDemo, setLoadingDemo] = useState(false);

  const [settings, setSettings] = useState<AppSettingsState>({
    geminiApiKey: "",
    defaultModel: DEFAULT_GEMINI_MODEL,
    customModel: "",
    rateLimitDelayMs: 750,
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
        `Estudio de ejemplo cargado: 12 variables y 3 historias clínicas ficticias listas para explorar.`,
        "success"
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "Error cargando estudio demo.",
        "error"
      );
    } finally {
      setLoadingDemo(false);
    }
  }

  async function handleDeleteStudy() {
    if (!activeStudy) return;
    const ok = window.confirm(
      `¿Eliminar permanentemente el estudio "${activeStudy.name}" junto con su diccionario, documentos y base de datos local?`
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
    onNotify("Respaldo completo del estudio descargado en JSON.", "success");
  }

  async function handleImportBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as StudyBackupPayload;
      const imported = await importStudyBackup(parsed);
      onStudyChanged(imported.id);
      onNotify(`Respaldo "${imported.name}" importado localmente.`, "success");
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "No se pudo importar el JSON.",
        "error"
      );
    } finally {
      e.target.value = "";
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    await saveAppSettings(settings);
    const updated = await getAppSettings();
    setSettings(updated);
    setSettingsOpen(false);
    onNotify(
      `Configuración guardada localmente. Modelo activo: ${
        updated.customModel || updated.defaultModel
      }.`,
      "success"
    );
  }

  const effectiveModelDisplay = normalizeGeminiModel(
    settings.customModel || settings.defaultModel
  );

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
          <Badge variant={settings.geminiApiKey ? "green" : "amber"}>
            <KeyRound className="h-3 w-3" />
            {settings.geminiApiKey
              ? `BYOK activo (${effectiveModelDisplay})`
              : `Sin BYOK (${effectiveModelDisplay} / Demo)`}
          </Badge>

          <Badge variant="slate" className="hidden sm:inline-flex">
            <ShieldCheck className="h-3 w-3 text-emerald-600" />
            Local-First (IndexedDB)
          </Badge>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            title="Configurar API Key Gemini y Respaldo JSON"
          >
            <Settings className="h-3.5 w-3.5" />
            Motor IA / Respaldo
          </Button>
        </div>
      </header>

      {/* Modal: Nuevo Estudio */}
      <Modal
        open={newStudyOpen}
        onClose={() => setNewStudyOpen(false)}
        title="Crear Nuevo Estudio Retrospectivo"
        subtitle="Cada estudio mantiene aislado su diccionario de variables, cohorte seudoanonimizada y casuística."
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
              Prefijo de seudoanonimización (ID secuencial) *
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

      {/* Modal: Configuración IA (BYOK) y Respaldo JSON */}
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Configuración de Motor IA y Respaldo Local"
        subtitle="Tu API Key y todos los datos clínicos se almacenan exclusivamente en IndexedDB de este navegador."
      >
        <div className="space-y-6">
          <form onSubmit={handleSaveSettings} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Google Gemini API Key (BYOK)
              </label>
              <Input
                type="password"
                placeholder="AIzaSy... (dejar vacío para usar GEMINI_API_KEY de .env o modo demo local)"
                value={settings.geminiApiKey}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, geminiApiKey: e.target.value }))
                }
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Si no configuras una API Key ni variable de entorno, el sistema ofrece un
                modo demostración local para probar todo el flujo sin costo.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Modelo Gemini por defecto
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
                  {GEMINI_MODEL_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
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
                  className="font-mono"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Modelo personalizado (opcional)
              </label>
              <Input
                type="text"
                placeholder="Ej. gemini-3.8-flash, gemini-3.8-pro o cualquier ID futuro de Google AI"
                value={settings.customModel}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    customModel: e.target.value,
                  }))
                }
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Si completas este campo, reemplazará al selector de arriba para futuras
                extracciones sin necesidad de modificar el código. Déjalo vacío para usar el
                modelo por defecto.
              </p>
            </div>

            <div className="flex justify-end">
              <Button type="submit" size="sm">
                Guardar Configuración IA
              </Button>
            </div>
          </form>

          <div className="border-t border-slate-200 pt-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <Database className="h-3.5 w-3.5" />
              Respaldo y Portabilidad Local (JSON)
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Exporta todo el estudio activo (diccionario, documentos, redacciones y
              validaciones) para respaldarlo en tu equipo o compartirlo de forma segura.
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
                Exportar Respaldo JSON
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => backupInputRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
                Importar Respaldo JSON
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
                  Eliminar Estudio Activo
                </Button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
