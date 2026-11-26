import { db, generateId } from "./db";
import { redactClinicalText } from "./redactor";
import {
  DEFAULT_REDACTION_RULES,
  type ClinicalDocument,
  type ExtractionRecord,
  type Patient,
  type Study,
  type StudyVariable,
  type VariableTemplateBlock,
} from "./types";

export const ONCOLOGY_TEMPLATE_BLOCKS: VariableTemplateBlock[] = [
  {
    id: "tpl-demografia",
    section: "demografia",
    title: "Demografía y Estado Funcional",
    description:
      "Variables basales del paciente: edad al diagnóstico, sexo biológico, ECOG, comorbilidades (Charlson) y tabaquismo.",
    variables: [
      {
        technicalName: "edad_diagnostico",
        label: "Edad al diagnóstico",
        section: "demografia",
        type: "numeric",
        options: [],
        unit: "años",
        aiInstruction:
          "Registrar la edad en años cumplidos al momento del diagnóstico oncológico inicial.",
        missingValue: "NR",
      },
      {
        technicalName: "sexo",
        label: "Sexo biológico",
        section: "demografia",
        type: "categorical_single",
        options: ["Femenino", "Masculino"],
        aiInstruction: "Identificar sexo biológico consignado en la historia clínica.",
        missingValue: "NR",
      },
      {
        technicalName: "ecog_basal",
        label: "ECOG al diagnóstico",
        section: "demografia",
        type: "categorical_single",
        options: ["0", "1", "2", "3", "4"],
        aiInstruction:
          "Tomar el puntaje de performance status ECOG previo al inicio de la primera línea de tratamiento.",
        missingValue: "NR",
      },
      {
        technicalName: "charlson_score",
        label: "Índice de Charlson",
        section: "demografia",
        type: "numeric",
        options: [],
        unit: "pts",
        aiInstruction:
          "Extraer únicamente si el índice de comorbilidad de Charlson figura calculado explícitamente en la historia clínica.",
        missingValue: "NR",
      },
      {
        technicalName: "tabaquismo",
        label: "Antecedente de tabaquismo",
        section: "demografia",
        type: "categorical_single",
        options: ["Nunca fumador", "Ex tabaquista", "Tabaquista activo"],
        aiInstruction:
          "Clasificar el hábito tabáquico según antecedentes personales.",
        missingValue: "NR",
      },
    ],
  },
  {
    id: "tpl-enfermedad",
    section: "enfermedad",
    title: "Enfermedad y Biología",
    description:
      "Sitio primario, histología, grado histológico, estadio TNM AJCC 8va, sitios de metástasis y biomarcadores moleculares.",
    variables: [
      {
        technicalName: "sitio_primario",
        label: "Sitio tumoral primario",
        section: "enfermedad",
        type: "categorical_single",
        options: [
          "Pulmón",
          "Mama",
          "Colorrectal",
          "Próstata",
          "Páncreas",
          "Riñón",
          "Melanoma",
          "Otro",
        ],
        aiInstruction: "Identificar el órgano de origen del tumor primario.",
        missingValue: "NR",
      },
      {
        technicalName: "histologia",
        label: "Subtipo histológico",
        section: "enfermedad",
        type: "text",
        options: [],
        aiInstruction:
          "Extraer el diagnóstico histológico definitivo del informe de anatomía patológica (ej. Adenocarcinoma, Carcinoma escamoso).",
        missingValue: "NR",
      },
      {
        technicalName: "grado_histologico",
        label: "Grado histológico",
        section: "enfermedad",
        type: "categorical_single",
        options: ["G1 (Bien diferenciado)", "G2 (Moderadamente diferenciado)", "G3 (Pobremente diferenciado)", "G4 (Indiferenciado)"],
        aiInstruction: "Tomar el grado de diferenciación del informe anatomopatológico.",
        missingValue: "NR",
      },
      {
        technicalName: "estadio_tnm",
        label: "Estadio al diagnóstico (AJCC 8va)",
        section: "enfermedad",
        type: "categorical_single",
        options: ["I", "II", "III", "IVA", "IVB", "IV (NOS)"],
        aiInstruction:
          "Clasificar el estadio global al diagnóstico según AJCC 8va edición. Priorizar estadificación definitiva completa (imágenes + patología).",
        missingValue: "NR",
      },
      {
        technicalName: "sitios_metastasis",
        label: "Sitios de metástasis al diagnóstico",
        section: "enfermedad",
        type: "categorical_multiple",
        options: [
          "Hígado",
          "Hueso",
          "SNC / Cerebro",
          "Pulmón contralateral",
          "Suprarrenal",
          "Pleura",
          "Ganglios a distancia",
          "Peritoneo",
        ],
        aiInstruction:
          "Listar todos los órganos con compromiso metastásico documentado por imágenes o biopsia al diagnóstico.",
        missingValue: "NR",
      },
      {
        technicalName: "biomarcadores",
        label: "Perfil molecular / Biomarcadores",
        section: "enfermedad",
        type: "text",
        options: [],
        aiInstruction:
          "Resumir mutaciones accionables y biomarcadores reportados con su resultado exacto (ej. EGFR exón 19 del, ALK negativo, PD-L1 TPS 60%).",
        missingValue: "NR",
      },
    ],
  },
  {
    id: "tpl-tratamiento",
    section: "tratamiento",
    title: "Tratamiento Oncológico",
    description:
      "Intención terapéutica, cirugía, radioterapia, esquemas de primera línea, fechas, motivo de suspensión y toxicidad G3+.",
    variables: [
      {
        technicalName: "intencion_terapeutica",
        label: "Intención terapéutica inicial",
        section: "tratamiento",
        type: "categorical_single",
        options: ["Curativa", "Neoadyuvante", "Adyuvante", "Paliativa"],
        aiInstruction:
          "Determinar la intención del tratamiento oncológico inicial consignado por oncología clínica.",
        missingValue: "NR",
      },
      {
        technicalName: "cirugia_oncologica",
        label: "Cirugía oncológica previa",
        section: "tratamiento",
        type: "boolean",
        options: [],
        aiInstruction:
          "Indicar Sí únicamente si el paciente recibió resección quirúrgica del tumor primario (no cuenta biopsia diagnóstica).",
        missingValue: "NR",
      },
      {
        technicalName: "radioterapia",
        label: "Recibió radioterapia",
        section: "tratamiento",
        type: "boolean",
        options: [],
        aiInstruction:
          "Indicar Sí si recibió radioterapia curativa, paliativa o radiocirugía (SRS/SBRT).",
        missingValue: "NR",
      },
      {
        technicalName: "linea_1_esquema",
        label: "Esquema sistémico 1ra línea",
        section: "tratamiento",
        type: "text",
        options: [],
        aiInstruction:
          "Consignar el nombre exacto de las drogas del esquema sistémico de primera línea (ej. Osimertinib 80 mg/día, Carboplatino + Pemetrexed + Pembrolizumab).",
        missingValue: "NR",
      },
      {
        technicalName: "linea_1_inicio",
        label: "Fecha inicio 1ra línea",
        section: "tratamiento",
        type: "date",
        options: [],
        aiInstruction:
          "Fecha exacta (DD/MM/AAAA) del primer ciclo o inicio de droga oral de primera línea.",
        missingValue: "NR",
      },
      {
        technicalName: "linea_1_motivo_suspension",
        label: "Motivo de suspensión 1ra línea",
        section: "tratamiento",
        type: "categorical_single",
        options: [
          "En curso",
          "Progresión de enfermedad",
          "Toxicidad inaceptable",
          "Fin de tratamiento planificado",
          "Óbito",
          "Decisión del paciente",
        ],
        aiInstruction:
          "Registrar la causa por la que finalizó la primera línea o 'En curso' si continúa activo al último control.",
        missingValue: "NR",
      },
      {
        technicalName: "toxicidad_g3_mas",
        label: "Toxicidad Grado ≥3 (CTCAE)",
        section: "tratamiento",
        type: "boolean",
        options: [],
        aiInstruction:
          "Indicar Sí si se documentó algún evento adverso relacionado al tratamiento de grado 3 o superior según CTCAE.",
        missingValue: "NR",
      },
    ],
  },
  {
    id: "tpl-desenlaces",
    section: "desenlaces",
    title: "Desenlaces y Supervivencia",
    description:
      "Fechas clave para análisis de Kaplan-Meier (SLP y SG): diagnóstico, progresión, último control, estado vital y óbito.",
    variables: [
      {
        technicalName: "fecha_diagnostico",
        label: "Fecha de diagnóstico anatomopatológico",
        section: "desenlaces",
        type: "date",
        options: [],
        aiInstruction:
          "Tomar la fecha del informe de anatomía patológica confirmatorio, NO la fecha de primera consulta ni de inicio de síntomas.",
        missingValue: "NR",
      },
      {
        technicalName: "fecha_progresion",
        label: "Fecha de primera progresión",
        section: "desenlaces",
        type: "date",
        options: [],
        aiInstruction:
          "Fecha del estudio de imágenes o evolución médica que documenta la primera progresión (RECIST o progresión clínica). Dejar missing si no progresó.",
        missingValue: "NR",
      },
      {
        technicalName: "fecha_ultimo_control",
        label: "Fecha de último control",
        section: "desenlaces",
        type: "date",
        options: [],
        aiInstruction:
          "Fecha más reciente de contacto clínico confirmado o fecha de óbito si falleció.",
        missingValue: "NR",
      },
      {
        technicalName: "estado_vital",
        label: "Estado vital al último control",
        section: "desenlaces",
        type: "categorical_single",
        options: ["Vivo sin enfermedad", "Vivo con enfermedad", "Fallecido", "Perdido en seguimiento"],
        aiInstruction:
          "Determinar el estado vital consignado en la evolución más reciente o epicrisis de defunción.",
        missingValue: "NR",
      },
      {
        technicalName: "fecha_obito",
        label: "Fecha de óbito",
        section: "desenlaces",
        type: "date",
        options: [],
        aiInstruction:
          "Consignar solo si el paciente falleció explícitamente. Dejar missing si continúa vivo.",
        missingValue: "NR",
      },
    ],
  },
];

/**
 * Crea un estudio oncológico de ejemplo completo (12 variables y 3 pacientes
 * ficticios multi-documento con citas verbatim verificables) para probar
 * inmediatamente el flujo end-to-end.
 */
export async function seedDemoStudy(): Promise<Study> {
  const now = new Date().toISOString();
  const studyId = generateId();

  const existingDemos = await db.studies
    .filter((s) => s.name.startsWith("Cohorte Retrospectiva Cáncer de Pulmón E-IV"))
    .count();

  const study: Study = {
    id: studyId,
    name:
      existingDemos > 0
        ? `Cohorte Retrospectiva Cáncer de Pulmón E-IV (Demo ${existingDemos + 1})`
        : "Cohorte Retrospectiva Cáncer de Pulmón E-IV (Demo)",
    description:
      "Estudio observacional retrospectivo unicéntrico de pacientes con CPNM estadio IV tratados con terapias dirigidas o inmunoterapia (2022-2025). Datos 100% ficticios para validación del flujo.",
    codePrefix: "PULM",
    nextPatientSeq: 4,
    redactionRules: { ...DEFAULT_REDACTION_RULES },
    createdAt: now,
    updatedAt: now,
  };

  // 12 variables clave oncológicas cubriendo los 6 tipos de datos y las 4 secciones
  const demoVariableDefs: Omit<StudyVariable, "id" | "studyId" | "order" | "createdAt">[] = [
    {
      technicalName: "edad_diagnostico",
      label: "Edad al diagnóstico",
      section: "demografia",
      type: "numeric",
      options: [],
      unit: "años",
      aiInstruction: "Edad en años cumplidos al momento del diagnóstico patológico.",
      missingValue: "NR",
    },
    {
      technicalName: "sexo",
      label: "Sexo biológico",
      section: "demografia",
      type: "categorical_single",
      options: ["Femenino", "Masculino"],
      aiInstruction: "Sexo biológico del paciente según historia clínica.",
      missingValue: "NR",
    },
    {
      technicalName: "ecog_basal",
      label: "ECOG al diagnóstico",
      section: "demografia",
      type: "categorical_single",
      options: ["0", "1", "2", "3", "4"],
      aiInstruction: "Puntaje ECOG previo al inicio de 1ra línea sistémica.",
      missingValue: "NR",
    },
    {
      technicalName: "histologia",
      label: "Histología tumoral",
      section: "enfermedad",
      type: "categorical_single",
      options: ["Adenocarcinoma", "Carcinoma escamoso", "Carcinoma de células grandes", "NOS"],
      aiInstruction: "Tomar del informe definitivo de anatomía patológica.",
      missingValue: "NR",
    },
    {
      technicalName: "estadio_tnm",
      label: "Estadio AJCC 8va",
      section: "enfermedad",
      type: "categorical_single",
      options: ["IVA", "IVB"],
      aiInstruction: "Clasificar según AJCC 8va edición (IVA: metástasis intratorácica o única extratorácica; IVB: múltiples metástasis extratorácicas).",
      missingValue: "NR",
    },
    {
      technicalName: "sitios_metastasis",
      label: "Sitios de metástasis",
      section: "enfermedad",
      type: "categorical_multiple",
      options: ["Hígado", "Hueso", "SNC / Cerebro", "Pleura", "Suprarrenal", "Pulmón contralateral"],
      aiInstruction: "Seleccionar todos los sitios metastásicos confirmados al diagnóstico.",
      missingValue: "NR",
    },
    {
      technicalName: "biomarcadores",
      label: "Perfil molecular (EGFR/ALK/PD-L1)",
      section: "enfermedad",
      type: "text",
      options: [],
      aiInstruction: "Indicar alteración driver principal y expresión de PD-L1 (TPS).",
      missingValue: "NR",
    },
    {
      technicalName: "linea_1_esquema",
      label: "Esquema 1ra línea",
      section: "tratamiento",
      type: "text",
      options: [],
      aiInstruction: "Esquema sistémico administrado en primera línea terapéutica.",
      missingValue: "NR",
    },
    {
      technicalName: "toxicidad_g3_mas",
      label: "Toxicidad Grado ≥3",
      section: "tratamiento",
      type: "boolean",
      options: [],
      aiInstruction: "Sí si se documentó evento adverso grado 3 o mayor CTCAE atribuible al tratamiento.",
      missingValue: "NR",
    },
    {
      technicalName: "fecha_diagnostico",
      label: "Fecha de diagnóstico",
      section: "desenlaces",
      type: "date",
      options: [],
      aiInstruction: "Tomar la fecha del informe de anatomía patológica confirmatorio, NO la primera consulta.",
      missingValue: "NR",
    },
    {
      technicalName: "fecha_ultimo_control",
      label: "Fecha de último control",
      section: "desenlaces",
      type: "date",
      options: [],
      aiInstruction: "Fecha más reciente de evolución médica o fecha de fallecimiento.",
      missingValue: "NR",
    },
    {
      technicalName: "estado_vital",
      label: "Estado vital",
      section: "desenlaces",
      type: "categorical_single",
      options: ["Vivo con enfermedad", "Fallecido", "Perdido en seguimiento"],
      aiInstruction: "Estado vital al último contacto registrado.",
      missingValue: "NR",
    },
  ];

  const variables: StudyVariable[] = demoVariableDefs.map((def, idx) => ({
    ...def,
    id: generateId(),
    studyId,
    order: idx,
    createdAt: now,
  }));

  const varByName = new Map(variables.map((v) => [v.technicalName, v]));

  // 3 pacientes ficticios con documentos realistas y PII sintético para demostrar el redactor
  const p1Id = generateId();
  const p2Id = generateId();
  const p3Id = generateId();

  const p1Doc1Raw = `HOSPITAL UNIVERSITARIO DEMO - SERVICIO DE ONCOLOGÍA CLÍNICA
Paciente: María Elena Gómez (FICTICIO) | DNI: 20.456.789 | HC: 998123
Tel: +54 11 4567-8901 | Email: maria.demo@ejemplo.org

EVOLUCIÓN DE INGRESO Y SEGUIMIENTO
Mujer de 62 años al diagnóstico, nunca fumadora, sin comorbilidades mayores. Consulta inicial el 04/03/2023 por tos seca persistente y disnea leve.
Al ingreso a oncología clínica se evalúa con estado funcional ECOG 1.
TC de tórax, abdomen y pelvis + RMN de cerebro (10/03/2023): masa en lóbulo superior derecho de 4.2 cm, derrame pleural maligno derecho y 2 lesiones secundarias en SNC (cerebelo y frontal izquierda), además de múltiples metástasis óseas en columna dorsal. Estadificación definitiva: Estadio IVB (cT2b N2 M1c, AJCC 8va edición).

TRATAMIENTO SISTÉMICO:
Inicia primera línea el 28/03/2023 con Osimertinib 80 mg/día vía oral.
Buena tolerancia clínica general: presenta rash acneiforme grado 1 y paroniquia leve. No se registraron toxicidades grado 3 ni internaciones relacionadas al tratamiento.

CONTROL MÁS RECIENTE (15/09/2025):
Paciente asintomática respiratoria, continúa con enfermedad controlada en tratamiento activo con Osimertinib. Estado vital actual: viva con enfermedad estable.`;

  const p1Doc2Raw = `INFORME DE ANATOMÍA PATOLÓGICA Y BIOLOGÍA MOLECULAR
Paciente: María Elena Gómez | HC: 998123
Fecha de emisión del informe confirmatorio: 14/03/2023

Material: Biopsia transbronquial de pulmón derecho.
Diagnóstico histológico: Adenocarcinoma de pulmón moderadamente diferenciado (TTF-1 positivo, Napsina A positivo, p40 negativo).
Panel NGS / Biomarcadores: Deleción del exón 19 de EGFR detectada (p.E746_A750del); ALK negativo por IHQ; ROS1 negativo; PD-L1 (22C3) TPS 15%.`;

  const p2Doc1Raw = `INSTITUTO MODELO DE ONCOLOGÍA - EPICRISIS Y EVOLUCIÓN
Paciente: Roberto Carlos Pereyra (FICTICIO) | DNI: 14.222.333 | HCD: 445102
Domicilio: Av. Rivadavia 4520, CABA

RESUMEN DE HISTORIA CLÍNICA:
Varón de 68 años, ex tabaquista severo (45 paquetes-año), EPOC leve.
Primera consulta en neumonología el 11/06/2022 por hemoptisis.
Evaluación funcional basal en oncología: ECOG 1.
PET-TC corporal total (20/06/2022): tumor central en pulmón izquierdo de 5.5 cm con compromiso ganglionar mediastinal N2 y lesión única en glándula suprarrenal izquierda (Estadio IVA, cT3 N2 M1b AJCC 8va). RMN cerebral sin secundarismo.

PLAN TERAPÉUTICO:
El 12/07/2022 comienza primera línea con Pembrolizumab 200 mg cada 21 días en monoterapia.
Al ciclo 5 (18/10/2022) presenta neumonitis inmunomediada grado 3 (CTCAE v5.0) que requirió internación y metilprednisolona EV, motivando suspensión definitiva de inmunoterapia.
Evolución posterior con progresión hepática en 05/2023, recibe quimioterapia de segunda línea con escasa respuesta.

EPICRISIS DE DEFUNCIÓN:
Fallece el 19/11/2023 por insuficiencia respiratoria secundaria a progresión de enfermedad de base.`;

  const p2Doc2Raw = `SERVICIO DE PATOLOGÍA TORÁCICA - PROTOCOLO P-2022-8841
Fecha de diagnóstico anatomopatológico: 24/06/2022
Paciente: Roberto Carlos Pereyra | DNI: 14.222.333

Diagnóstico: Carcinoma escamoso de pulmón (p40 positivo intenso, CK5/6 positivo, TTF-1 negativo).
Estudio molecular: EGFR no mutado (wild-type), ALK negativo, PD-L1 (22C3) TPS 80%.`;

  const p3Doc1Raw = `CLÍNICA ONCOLÓGICA SUR - CONSULTA DE SEGUIMIENTO
Paciente: Lucía Fernanda Morales (FICTICIO) | DNI: 24.889.110 | HC: 774209
Teléfono: 11-5544-3322

HISTORIA RESUMIDA:
Paciente de sexo femenino de 54 años al diagnóstico, tabaquista leve (8 paquetes-año).
Al inicio de seguimiento oncológico se encontraba plenamente activa, ECOG 0.
TC toracoabdominopelviana (05/01/2024): nódulo pulmonar izquierdo de 3.4 cm, múltiples nódulos pulmonares contralaterales y metástasis hepáticas bilobares (Estadio IVB, AJCC 8va edición).
Biopsia hepática informada el 12/01/2024: Adenocarcinoma de origen pulmonar (TTF-1+). Perfil molecular: EGFR negativo, ALK negativo, KRAS G12C positivo, PD-L1 TPS 5%.

TRATAMIENTO:
Inicia 1ra línea el 01/02/2024 con Carboplatino AUC 5 + Pemetrexed 500 mg/m2 + Pembrolizumab 200 mg cada 21 días por 4 ciclos, seguido de mantenimiento con Pemetrexed + Pembrolizumab.
Durante el ciclo 3 presentó neutropenia febril grado 3 con buena resolución tras antibióticos y G-CSF.

ÚLTIMO CONTROL REGISTRADO (20/08/2025):
Continúa en mantenimiento con respuesta parcial sostenida por TC. Paciente viva con enfermedad en control ambulatorio.`;

  const docsSpec: Array<{
    id: string;
    patientId: string;
    filename: string;
    category: ClinicalDocument["category"];
    rawText: string;
  }> = [
    {
      id: generateId(),
      patientId: p1Id,
      filename: "PULM-001_Epicrisis_Evolucion.txt",
      category: "epicrisis",
      rawText: p1Doc1Raw,
    },
    {
      id: generateId(),
      patientId: p1Id,
      filename: "PULM-001_Anatomia_Patologica.txt",
      category: "patologia",
      rawText: p1Doc2Raw,
    },
    {
      id: generateId(),
      patientId: p2Id,
      filename: "PULM-002_Epicrisis_Defuncion.txt",
      category: "epicrisis",
      rawText: p2Doc1Raw,
    },
    {
      id: generateId(),
      patientId: p2Id,
      filename: "PULM-002_Patologia_Toracica.txt",
      category: "patologia",
      rawText: p2Doc2Raw,
    },
    {
      id: generateId(),
      patientId: p3Id,
      filename: "PULM-003_Resumen_HCD.txt",
      category: "evolucion",
      rawText: p3Doc1Raw,
    },
  ];

  const documents: ClinicalDocument[] = docsSpec.map((spec) => {
    const red = redactClinicalText(spec.rawText, DEFAULT_REDACTION_RULES);
    return {
      id: spec.id,
      studyId,
      patientId: spec.patientId,
      filename: spec.filename,
      fileType: "txt",
      category: spec.category,
      rawText: spec.rawText,
      redactedText: red.redactedText,
      redactionCount: red.totalRedactions,
      redactionSummary: red.countsByType,
      redactionConfirmed: true,
      uploadedAt: now,
    };
  });

  const patients: Patient[] = [
    {
      id: p1Id,
      studyId,
      studyCode: "PULM-001",
      originalIdentifier: "HC-998123 (Demo Ficticio 1)",
      validationStatus: "validated",
      extractionStatus: "done",
      researcherNotes: "Caso validado. Biomarcador EGFR ex19 del confirmado en NGS.",
      lastExtractedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: p2Id,
      studyId,
      studyCode: "PULM-002",
      originalIdentifier: "HCD-445102 (Demo Ficticio 2)",
      validationStatus: "in_review",
      extractionStatus: "done",
      researcherNotes:
        "Revisar fecha de diagnóstico patológico (24/06/2022) vs primera consulta (11/06/2022).",
      lastExtractedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: p3Id,
      studyId,
      studyCode: "PULM-003",
      originalIdentifier: "HC-774209 (Demo Ficticio 3)",
      validationStatus: "pending",
      extractionStatus: "done",
      researcherNotes: "",
      lastExtractedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const docByFilename = new Map(documents.map((d) => [d.filename, d]));

  function makeExt(
    patientId: string,
    techName: string,
    value: ExtractionRecord["value"],
    confidence: ExtractionRecord["confidence"],
    evidenceQuote: string | null,
    docFilename: string | null,
    reasoning: string | null = null
  ): ExtractionRecord {
    const variable = varByName.get(techName)!;
    const doc = docFilename ? docByFilename.get(docFilename) : undefined;
    return {
      id: generateId(),
      studyId,
      patientId,
      variableId: variable.id,
      value,
      status: value === null ? "missing" : "extracted",
      confidence,
      evidenceQuote,
      sourceDocumentId: doc?.id ?? null,
      sourceDocumentName: doc?.filename ?? null,
      reasoning,
      manuallyEdited: false,
      modelUsed: "demo-precargado",
      updatedAt: now,
    };
  }

  const extractions: ExtractionRecord[] = [
    // PULM-001
    makeExt(p1Id, "edad_diagnostico", 62, "alta", "Mujer de 62 años al diagnóstico, nunca fumadora", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "sexo", "Femenino", "alta", "Mujer de 62 años al diagnóstico", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "ecog_basal", "1", "alta", "se evalúa con estado funcional ECOG 1.", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "histologia", "Adenocarcinoma", "alta", "Diagnóstico histológico: Adenocarcinoma de pulmón moderadamente diferenciado", "PULM-001_Anatomia_Patologica.txt"),
    makeExt(p1Id, "estadio_tnm", "IVB", "alta", "Estadificación definitiva: Estadio IVB (cT2b N2 M1c, AJCC 8va edición).", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "sitios_metastasis", ["Pleura", "SNC / Cerebro", "Hueso"], "alta", "derrame pleural maligno derecho y 2 lesiones secundarias en SNC (cerebelo y frontal izquierda), además de múltiples metástasis óseas en columna dorsal.", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "biomarcadores", "EGFR exón 19 del (p.E746_A750del); ALK (-); ROS1 (-); PD-L1 TPS 15%", "alta", "Deleción del exón 19 de EGFR detectada (p.E746_A750del); ALK negativo por IHQ; ROS1 negativo; PD-L1 (22C3) TPS 15%.", "PULM-001_Anatomia_Patologica.txt"),
    makeExt(p1Id, "linea_1_esquema", "Osimertinib 80 mg/día", "alta", "Inicia primera línea el 28/03/2023 con Osimertinib 80 mg/día vía oral.", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "toxicidad_g3_mas", "No", "alta", "No se registraron toxicidades grado 3 ni internaciones relacionadas al tratamiento.", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "fecha_diagnostico", "14/03/2023", "alta", "Fecha de emisión del informe confirmatorio: 14/03/2023", "PULM-001_Anatomia_Patologica.txt", "Se priorizó la fecha del informe de anatomía patológica sobre la consulta inicial del 04/03/2023."),
    makeExt(p1Id, "fecha_ultimo_control", "15/09/2025", "alta", "CONTROL MÁS RECIENTE (15/09/2025):", "PULM-001_Epicrisis_Evolucion.txt"),
    makeExt(p1Id, "estado_vital", "Vivo con enfermedad", "alta", "Estado vital actual: viva con enfermedad estable.", "PULM-001_Epicrisis_Evolucion.txt"),

    // PULM-002
    makeExt(p2Id, "edad_diagnostico", 68, "alta", "Varón de 68 años, ex tabaquista severo (45 paquetes-año)", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "sexo", "Masculino", "alta", "Varón de 68 años, ex tabaquista severo", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "ecog_basal", "1", "alta", "Evaluación funcional basal en oncología: ECOG 1.", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "histologia", "Carcinoma escamoso", "alta", "Diagnóstico: Carcinoma escamoso de pulmón (p40 positivo intenso", "PULM-002_Patologia_Toracica.txt"),
    makeExt(p2Id, "estadio_tnm", "IVA", "alta", "lesión única en glándula suprarrenal izquierda (Estadio IVA, cT3 N2 M1b AJCC 8va).", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "sitios_metastasis", ["Suprarrenal"], "alta", "lesión única en glándula suprarrenal izquierda (Estadio IVA", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "biomarcadores", "EGFR WT; ALK (-); PD-L1 TPS 80%", "alta", "EGFR no mutado (wild-type), ALK negativo, PD-L1 (22C3) TPS 80%.", "PULM-002_Patologia_Toracica.txt"),
    makeExt(p2Id, "linea_1_esquema", "Pembrolizumab 200 mg c/21 días", "alta", "comienza primera línea con Pembrolizumab 200 mg cada 21 días en monoterapia.", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "toxicidad_g3_mas", "Sí", "alta", "presenta neumonitis inmunomediada grado 3 (CTCAE v5.0) que requirió internación", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "fecha_diagnostico", "24/06/2022", "media", "Fecha de diagnóstico anatomopatológico: 24/06/2022", "PULM-002_Patologia_Toracica.txt", "Se utilizó la fecha confirmatoria de patología (24/06/2022) en lugar de la primera consulta (11/06/2022)."),
    makeExt(p2Id, "fecha_ultimo_control", "19/11/2023", "alta", "Fallece el 19/11/2023 por insuficiencia respiratoria secundaria a progresión", "PULM-002_Epicrisis_Defuncion.txt"),
    makeExt(p2Id, "estado_vital", "Fallecido", "alta", "Fallece el 19/11/2023 por insuficiencia respiratoria secundaria a progresión de enfermedad de base.", "PULM-002_Epicrisis_Defuncion.txt"),

    // PULM-003
    makeExt(p3Id, "edad_diagnostico", 54, "alta", "Paciente de sexo femenino de 54 años al diagnóstico", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "sexo", "Femenino", "alta", "Paciente de sexo femenino de 54 años al diagnóstico", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "ecog_basal", "0", "alta", "se encontraba plenamente activa, ECOG 0.", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "histologia", "Adenocarcinoma", "alta", "Biopsia hepática informada el 12/01/2024: Adenocarcinoma de origen pulmonar", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "estadio_tnm", "IVB", "alta", "metástasis hepáticas bilobares (Estadio IVB, AJCC 8va edición).", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "sitios_metastasis", ["Pulmón contralateral", "Hígado"], "alta", "múltiples nódulos pulmonares contralaterales y metástasis hepáticas bilobares", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "biomarcadores", "EGFR (-); ALK (-); KRAS G12C (+); PD-L1 TPS 5%", "media", "Perfil molecular: EGFR negativo, ALK negativo, KRAS G12C positivo, PD-L1 TPS 5%.", "PULM-003_Resumen_HCD.txt", "Se incluyó mutación KRAS G12C reportada en el mismo panel."),
    makeExt(p3Id, "linea_1_esquema", "Carboplatino + Pemetrexed + Pembrolizumab", "alta", "Carboplatino AUC 5 + Pemetrexed 500 mg/m2 + Pembrolizumab 200 mg cada 21 días", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "toxicidad_g3_mas", "Sí", "alta", "Durante el ciclo 3 presentó neutropenia febril grado 3 con buena resolución", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "fecha_diagnostico", "12/01/2024", "alta", "Biopsia hepática informada el 12/01/2024: Adenocarcinoma de origen pulmonar", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "fecha_ultimo_control", "20/08/2025", "alta", "ÚLTIMO CONTROL REGISTRADO (20/08/2025):", "PULM-003_Resumen_HCD.txt"),
    makeExt(p3Id, "estado_vital", "Vivo con enfermedad", "alta", "Paciente viva con enfermedad en control ambulatorio.", "PULM-003_Resumen_HCD.txt"),
  ];

  await db.transaction(
    "rw",
    [db.studies, db.variables, db.patients, db.documents, db.extractions],
    async () => {
      await db.studies.add(study);
      await db.variables.bulkAdd(variables);
      await db.patients.bulkAdd(patients);
      await db.documents.bulkAdd(documents);
      await db.extractions.bulkAdd(extractions);
    }
  );

  return study;
}
