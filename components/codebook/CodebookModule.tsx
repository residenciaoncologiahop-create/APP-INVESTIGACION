"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  db,
  deleteVariableCascade,
  generateId,
  sanitizeTechnicalName,
} from "@/lib/db";
import { downloadJsonFile } from "@/lib/exporters";
import { buildGeminiResponseSchema } from "@/lib/schema-builder";
import { ONCOLOGY_TEMPLATE_BLOCKS } from "@/lib/templates";
import {
  VARIABLE_SECTION_LABELS,
  VARIABLE_TYPE_LABELS,
  type CodebookExportPayload,
  type Study,
  type StudyVariable,
  type VariableSection,
  type VariableType,
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

interface CodebookModuleProps {
  study: Study;
  variables: StudyVariable[];
  onNotify: (msg: string, tone?: "info" | "success" | "error") => void;
  onGoNextStep: () => void;
}

interface VariableFormState {
  id?: string;
  technicalName: string;
  label: string;
  section: VariableSection;
  type: VariableType;
  optionsRaw: string;
  unit: string;
  aiInstruction: string;
  missingValue: string;
}

const EMPTY_FORM: VariableFormState = {
  technicalName: "",
  label: "",
  section: "enfermedad",
  type: "categorical_single",
  optionsRaw: "",
  unit: "",
  aiInstruction: "",
  missingValue: "NR",
};

export function CodebookModule({
  study,
  variables,
  onNotify,
  onGoNextStep,
}: CodebookModuleProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [advancedSchemaOpen, setAdvancedSchemaOpen] = useState(false);
  const [form, setForm] = useState<VariableFormState>(EMPTY_FORM);
  const [sectionFilter, setSectionFilter] = useState<string>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredVariables = useMemo(() => {
    if (sectionFilter === "all") return variables;
    return variables.filter((v) => v.section === sectionFilter);
  }, [variables, sectionFilter]);

  const jsonSchemaPreview = useMemo(() => {
    if (!advancedSchemaOpen) return "";
    return JSON.stringify(buildGeminiResponseSchema(variables), null, 2);
  }, [advancedSchemaOpen, variables]);

  function openNewVariable() {
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEditVariable(v: StudyVariable) {
    setForm({
      id: v.id,
      technicalName: v.technicalName,
      label: v.label,
      section: v.section,
      type: v.type,
      optionsRaw: v.options.join("\n"),
      unit: v.unit || "",
      aiInstruction: v.aiInstruction,
      missingValue: v.missingValue || "NR",
    });
    setModalOpen(true);
  }

  async function handleSaveVariable(e: React.FormEvent) {
    e.preventDefault();
    const techName = sanitizeTechnicalName(form.technicalName || form.label);
    if (!techName) {
      onNotify("El nombre técnico es obligatorio (solo letras, números y guion bajo).", "error");
      return;
    }

    const duplicate = variables.find(
      (v) => v.technicalName === techName && v.id !== form.id
    );
    if (duplicate) {
      onNotify(`Ya existe una variable con el nombre técnico "${techName}".`, "error");
      return;
    }

    const options =
      form.type === "categorical_single" || form.type === "categorical_multiple"
        ? form.optionsRaw
            .split(/[\n,|]+/)
            .map((o) => o.trim())
            .filter(Boolean)
        : [];

    if (
      (form.type === "categorical_single" || form.type === "categorical_multiple") &&
      options.length === 0
    ) {
      onNotify("Agrega al menos una categoría permitida para variables categóricas.", "error");
      return;
    }

    if (form.id) {
      await db.variables.update(form.id, {
        technicalName: techName,
        label: form.label.trim() || techName,
        section: form.section,
        type: form.type,
        options,
        unit: form.unit.trim() || undefined,
        aiInstruction: form.aiInstruction.trim(),
        missingValue: form.missingValue.trim() || "NR",
      });
      onNotify(`Variable "${techName}" actualizada.`, "success");
    } else {
      const nextOrder =
        variables.length > 0 ? Math.max(...variables.map((v) => v.order)) + 1 : 0;
      await db.variables.add({
        id: generateId(),
        studyId: study.id,
        technicalName: techName,
        label: form.label.trim() || techName,
        section: form.section,
        type: form.type,
        options,
        unit: form.unit.trim() || undefined,
        aiInstruction: form.aiInstruction.trim(),
        missingValue: form.missingValue.trim() || "NR",
        order: nextOrder,
        createdAt: new Date().toISOString(),
      });
      onNotify(`Variable "${techName}" agregada al diccionario.`, "success");
    }
    setModalOpen(false);
  }

  async function handleAddTemplateBlock(blockId: string) {
    const block = ONCOLOGY_TEMPLATE_BLOCKS.find((b) => b.id === blockId);
    if (!block) return;

    const existingNames = new Set(variables.map((v) => v.technicalName));
    const maxOrder =
      variables.length > 0 ? Math.max(...variables.map((v) => v.order)) : -1;
    const now = new Date().toISOString();

    const toInsert: StudyVariable[] = [];
    let offset = 1;
    for (const tplVar of block.variables) {
      if (existingNames.has(tplVar.technicalName)) continue;
      toInsert.push({
        ...tplVar,
        id: generateId(),
        studyId: study.id,
        order: maxOrder + offset,
        createdAt: now,
      });
      offset += 1;
    }

    if (toInsert.length === 0) {
      onNotify(
        `Todas las variables del bloque "${block.title}" ya están cargadas en el diccionario.`,
        "info"
      );
      return;
    }

    await db.variables.bulkAdd(toInsert);
    onNotify(
      `Se agregaron ${toInsert.length} variables de "${block.title}". Puedes editarlas libremente.`,
      "success"
    );
  }

  async function handleMoveVariable(index: number, direction: -1 | 1) {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= variables.length) return;
    const a = variables[index];
    const b = variables[targetIdx];
    await db.transaction("rw", db.variables, async () => {
      await db.variables.update(a.id, { order: b.order });
      await db.variables.update(b.id, { order: a.order });
    });
  }

  async function handleDeleteVariable(v: StudyVariable) {
    const ok = window.confirm(
      `¿Eliminar la variable "${v.technicalName}" (${v.label})? También se eliminarán los valores extraídos para esta columna.`
    );
    if (!ok) return;
    await deleteVariableCascade(v.id);
    onNotify(`Variable "${v.technicalName}" eliminada.`, "info");
  }

  function handleExportCodebook() {
    const payload: CodebookExportPayload = {
      schemaVersion: 1,
      studyName: study.name,
      exportedAt: new Date().toISOString(),
      variables: variables.map(({ id: _id, studyId: _sid, createdAt: _c, ...rest }) => rest),
    };
    downloadJsonFile(
      payload,
      `diccionario_${study.codePrefix.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.json`
    );
    onNotify("Diccionario de variables exportado en JSON.", "success");
  }

  async function handleImportCodebook(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as CodebookExportPayload;
      if (!parsed || !Array.isArray(parsed.variables)) {
        throw new Error("El JSON no contiene un listado válido de variables.");
      }
      const existingNames = new Set(variables.map((v) => v.technicalName));
      let nextOrder =
        variables.length > 0 ? Math.max(...variables.map((v) => v.order)) + 1 : 0;
      const now = new Date().toISOString();

      const newItems: StudyVariable[] = [];
      for (const item of parsed.variables) {
        const cleanTech = sanitizeTechnicalName(item.technicalName || item.label || "");
        if (!cleanTech || existingNames.has(cleanTech)) continue;
        existingNames.add(cleanTech);
        newItems.push({
          id: generateId(),
          studyId: study.id,
          technicalName: cleanTech,
          label: item.label || cleanTech,
          section: item.section || "custom",
          type: item.type || "text",
          options: Array.isArray(item.options) ? item.options : [],
          aiInstruction: item.aiInstruction || "",
          missingValue: item.missingValue || "NR",
          unit: item.unit,
          order: nextOrder++,
          createdAt: now,
        });
      }

      if (newItems.length === 0) {
        onNotify("No se encontraron variables nuevas para importar (ya existían).", "info");
      } else {
        await db.variables.bulkAdd(newItems);
        onNotify(`Se importaron ${newItems.length} variables al diccionario.`, "success");
      }
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : "Error importando el diccionario JSON.",
        "error"
      );
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div className="space-y-5">
      {/* Encabezado del módulo */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            1. Variables del estudio
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Definí qué datos clínicos querés recolectar de cada historia, sus categorías
            permitidas y los criterios médicos para la extracción estructurada.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCodebook} disabled={variables.length === 0}>
            <Download className="h-3.5 w-3.5" />
            Exportar variables
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            Importar variables
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportCodebook}
          />
          <Button size="sm" onClick={openNewVariable}>
            <Plus className="h-3.5 w-3.5" />
            Nueva Variable
          </Button>
        </div>
      </div>

      {/* Plantillas Oncológicas Preconfiguradas */}
      <Card className="p-4 bg-slate-50/70">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-700" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-700">
              Plantillas Oncológicas Preconfiguradas (Carga Rápida)
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            Haz clic en un bloque para agregar sus variables editables
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {ONCOLOGY_TEMPLATE_BLOCKS.map((block) => {
            const loadedCount = block.variables.filter((tv) =>
              variables.some((v) => v.technicalName === tv.technicalName)
            ).length;
            return (
              <div
                key={block.id}
                className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-3.5 transition hover:border-sky-300"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{block.title}</span>
                    <Badge variant={loadedCount === block.variables.length ? "green" : "blue"}>
                      {loadedCount}/{block.variables.length}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    {block.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  className="mt-3 w-full"
                  onClick={() => handleAddTemplateBlock(block.id)}
                >
                  <Plus className="h-3 w-3" />
                  {loadedCount === block.variables.length
                    ? "Bloque ya cargado"
                    : `Cargar bloque (+${block.variables.length - loadedCount})`}
                </Button>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Tabla de Variables */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-semibold text-slate-800">
              Variables definidas ({variables.length})
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Sección:</span>
            <select
              value={sectionFilter}
              onChange={(e) => setSectionFilter(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
            >
              <option value="all">Todas las secciones ({variables.length})</option>
              {Object.entries(VARIABLE_SECTION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {filteredVariables.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-700">
              Aún no hay variables en este diccionario.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Carga una plantilla oncológica arriba o crea tu primera variable personalizada.
            </p>
            <Button size="sm" className="mt-4" onClick={openNewVariable}>
              <Plus className="h-3.5 w-3.5" />
              Crear primera variable
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 w-16">Orden</th>
                  <th className="px-3 py-2.5">Variable / Nombre de columna</th>
                  <th className="px-3 py-2.5">Sección</th>
                  <th className="px-3 py-2.5">Tipo y Categorías</th>
                  <th className="px-3 py-2.5">Criterio clínico de extracción</th>
                  <th className="px-3 py-2.5 w-20 text-center">Faltante</th>
                  <th className="px-3 py-2.5 w-24 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVariables.map((v) => {
                  const fullIdx = variables.findIndex((x) => x.id === v.id);
                  return (
                    <tr key={v.id} className="hover:bg-slate-50/80">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-[11px] text-slate-400 w-5">
                            {fullIdx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleMoveVariable(fullIdx, -1)}
                            disabled={fullIdx === 0}
                            className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 cursor-pointer"
                            title="Subir"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMoveVariable(fullIdx, 1)}
                            disabled={fullIdx === variables.length - 1}
                            className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 cursor-pointer"
                            title="Bajar"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-slate-900">{v.label}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-sky-800">
                            {v.technicalName}
                          </code>
                          {v.unit && (
                            <span className="font-mono text-[10px] text-slate-500">
                              [{v.unit}]
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="slate">{VARIABLE_SECTION_LABELS[v.section]}</Badge>
                      </td>
                      <td className="px-3 py-2.5 max-w-[240px]">
                        <Badge variant="blue">{VARIABLE_TYPE_LABELS[v.type]}</Badge>
                        {v.options.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {v.options.map((opt) => (
                              <span
                                key={opt}
                                className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600"
                              >
                                {opt}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 max-w-[320px] text-slate-600 leading-relaxed">
                        {v.aiInstruction || (
                          <span className="italic text-slate-400">Sin criterio adicional</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                          {v.missingValue || "NR"}
                        </code>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditVariable(v)}
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-700 cursor-pointer"
                            title="Editar variable"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteVariable(v)}
                            className="rounded p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                            title="Eliminar variable"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {variables.length > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-600">
              Variables listas: <strong>{variables.length}</strong> columnas. Si agregás
              nuevas variables más adelante, podrás extraer únicamente las columnas nuevas.
            </p>
            <Button size="sm" onClick={onGoNextStep}>
              Continuar a Paso 2: Cargar historias clínicas →
            </Button>
          </div>
        )}
      </Card>

      {/* Desplegable cerrado por defecto para ver formato técnico avanzado */}
      {variables.length > 0 && (
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvancedSchemaOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
          >
            <span>Ver formato técnico avanzado</span>
            {advancedSchemaOpen ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )}
          </button>
          {advancedSchemaOpen && (
            <div className="border-t border-slate-200 p-4">
              <p className="mb-2 text-xs text-slate-500">
                Estructura técnica generada automáticamente a partir de las variables del estudio
                para asegurar respuestas consistentes.
              </p>
              <pre className="max-h-[50vh] overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-xs text-sky-200">
                {jsonSchemaPreview}
              </pre>
            </div>
          )}
        </Card>
      )}

      {/* Modal Crear / Editar Variable */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "Editar Variable del Diccionario" : "Nueva Variable Clínica"}
        subtitle="Define el tipo de dato estricto y el criterio clínico para evitar ambigüedades en la extracción."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveVariable} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Etiqueta legible *
              </label>
              <Input
                required
                placeholder="Ej. ECOG al diagnóstico"
                value={form.label}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm((prev) => ({
                    ...prev,
                    label: val,
                    technicalName: prev.id
                      ? prev.technicalName
                      : sanitizeTechnicalName(val),
                  }));
                }}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Nombre de columna (Excel / R / SPSS) *
              </label>
              <Input
                required
                placeholder="Ej. ecog_basal"
                value={form.technicalName}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    technicalName: sanitizeTechnicalName(e.target.value),
                  }))
                }
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Sección clínica
              </label>
              <Select
                value={form.section}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    section: e.target.value as VariableSection,
                  }))
                }
              >
                {Object.entries(VARIABLE_SECTION_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Tipo de dato *
              </label>
              <Select
                value={form.type}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    type: e.target.value as VariableType,
                  }))
                }
              >
                {Object.entries(VARIABLE_TYPE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Valor dato faltante
              </label>
              <Input
                placeholder="NR"
                value={form.missingValue}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, missingValue: e.target.value }))
                }
                className="font-mono text-xs"
              />
            </div>
          </div>

          {form.type === "numeric" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Unidad de medida (opcional)
              </label>
              <Input
                placeholder="Ej. años, cm, mg/dL, meses"
                value={form.unit}
                onChange={(e) => setForm((prev) => ({ ...prev, unit: e.target.value }))}
              />
            </div>
          )}

          {(form.type === "categorical_single" ||
            form.type === "categorical_multiple") && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                Lista cerrada de opciones permitidas (una por línea o separadas por coma) *
              </label>
              <Textarea
                rows={4}
                required
                placeholder={"IVA\nIVB\nIII\nII"}
                value={form.optionsRaw}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, optionsRaw: e.target.value }))
                }
                className="font-mono text-xs"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Criterio clínico para la extracción
            </label>
            <Textarea
              rows={3}
              placeholder='Ej. "Tomar la fecha del informe de anatomía patológica confirmatorio, no la fecha de primera consulta" o "Clasificar según AJCC 8va edición".'
              value={form.aiInstruction}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, aiInstruction: e.target.value }))
              }
            />
            <p className="mt-1 text-[11px] text-slate-500">
              La IA no asume ni completa datos por probabilidad clínica: si no hay evidencia
              explícita en la historia clínica, quedará registrado como dato faltante (
              {form.missingValue || "NR"}).
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setModalOpen(false)}
            >
              Cancelar
            </Button>
            <Button type="submit">
              {form.id ? "Guardar Cambios" : "Agregar Variable"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
