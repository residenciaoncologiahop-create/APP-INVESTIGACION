# OncoData Extract — Plataforma de Extracción y Estructuración de Datos Clínicos para Investigación Oncológica Retrospectiva

Aplicación web **local-first** orientada a equipos de oncología clínica para transformar historias clínicas digitales (HCD) no estructuradas (`.pdf`, `.docx`, `.txt` o texto pegado) en bases de datos estructuradas, auditables y listas para análisis bioestadístico (**R, SPSS, Jamovi, Stata, Python**) y publicación científica.

---

## Características Principales

1. **Gestor Multi-Estudio (Local-First en IndexedDB):**
   - Múltiples proyectos independientes con diccionarios, cohortes y reglas de privacidad aislados en el navegador mediante `Dexie.js`.
   - Respaldo completo y portabilidad en JSON.

2. **Constructor de Diccionario de Variables (Codebook + JSON Schema Dinámico):**
   - Soporta 6 tipos de datos (`Numérico`, `Fecha DD/MM/AAAA`, `Categórico Único`, `Categórico Múltiple`, `Booleano Sí/No/Desconocido`, `Texto libre breve`).
   - Instrucción clínica específica por variable (prompt de criterios como AJCC 8va o prioridad a anatomía patológica) y valor estandarizado para datos faltantes (`NR`).
   - **4 Plantillas Oncológicas Preconfiguradas** (Demografía, Enfermedad y Biología, Tratamiento, Desenlaces/Supervivencia) e importación/exportación del diccionario en JSON.

3. **Ingesta por Lotes y Seudoanonimización Pre-IA:**
   - Procesamiento client-side de `.pdf` (`pdfjs-dist` con worker local), `.docx` (`mammoth`) y `.txt`.
   - Agrupación multi-documento por paciente (ej. Epicrisis + Anatomía Patológica + TAC).
   - Filtro local configurable que redacta DNI/CUIL, nombres en encabezados, teléfonos, correos, direcciones, N° de historia clínica y términos personalizados por `[REDACTADO]` antes del envío a Gemini.
   - Descarga independiente de la **Tabla Llave** (ID seudoanonimizado ↔ Identificador local).

4. **Motor de Extracción IA con Trazabilidad Clínica (`gemini-3.8-flash` / `gemini-3.8-pro` / modelo personalizado):**
   - Compilación dinámica del diccionario en **Structured Outputs (JSON Schema estricto)**.
   - Cada celda extraída incluye `value`, `status`, `confidence`, `evidence_quote` (cita textual verbatim) y `reasoning`.
   - Cola por lotes con barra de progreso, pausa/reanudación, backoff exponencial ante límites de tasa (`429`) y **re-extracción incremental** solo para variables nuevas agregadas después.
   - Incluye **Modo Demostración Local** automático cuando no hay API Key configurada.

5. **Workspace Split-Screen Human-in-the-Loop:**
   - Visor multi-documento a la izquierda y formulario por secciones a la derecha.
   - Al hacer clic en cualquier variable, el visor salta automáticamente al documento fuente y resalta en amarillo la cita textual verbatim.
   - Semáforo de confianza, edición manual directa, notas del investigador y aprobación (`Pendiente` → `En revisión` → `Validado`).

6. **Tabla Maestra, Casuística y Exportación Científica:**
   - Vista planilla con filtros, búsqueda, edición inline y completitud por fila/columna.
   - Estadística descriptiva automática (mediana/RIC, media/DE, frecuencias $n$, $\%$), mapa de *missingness* (`Recharts`) y **calculadora automática de intervalos de tiempo** para curvas de Kaplan-Meier (SG / SLP).
   - Exportación a **Excel multipestaña (`.xlsx`)** con 3 hojas (`Base_Datos_Limpia`, `Diccionario_Variables`, `Auditoria_Citas_IA`) y **CSV UTF-8 con BOM**.

---

## Instalación y Ejecución Local

### Requisitos
- Node.js 20+ (probado en Node 24)

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar `GEMINI_API_KEY` (2 opciones)

**Opción A — Variable de entorno local (`.env.local`):**
Copia `.env.example` a `.env.local` en la raíz del proyecto y coloca tu clave de [Google AI Studio](https://aistudio.google.com/apikey):

```env
GEMINI_API_KEY=AIzaSyTU_CLAVE_AQUI
```

**Opción B — BYOK desde la interfaz (sin editar archivos):**
1. Inicia la aplicación y haz clic en **"Motor IA / Respaldo"** en la barra superior.
2. Ingresa tu `Google Gemini API Key` y selecciona el modelo por defecto (`gemini-3.8-flash` recomendado para lotes grandes, `gemini-3.8-pro` para máxima precisión, o ingresa un **Modelo personalizado**).
3. La clave se guarda únicamente en `IndexedDB` dentro de tu navegador.

> **Nota sobre Modo Demo:** Si no configuras ninguna API Key, puedes probar todo el flujo inmediatamente usando el botón **"Cargar Estudio de Ejemplo"** (12 variables oncológicas + 3 historias clínicas ficticias multi-documento) y el extractor heurístico local incluido.

### 3. Correr en desarrollo o producción
```bash
# Modo desarrollo
npm run dev

# Verificación de tipos TypeScript y build de producción
npm run typecheck
npm run build
npm run start
```

Luego abre `http://localhost:3000` en tu navegador.
