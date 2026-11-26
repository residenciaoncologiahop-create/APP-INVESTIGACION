import type { ExtractionRecord, Patient, StudyVariable } from "./types";

export interface NumericVariableStats {
  kind: "numeric";
  n: number;
  missing: number;
  missingPct: number;
  mean: number | null;
  sd: number | null;
  median: number | null;
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  min: number | null;
  max: number | null;
}

export interface CategoricalFrequency {
  label: string;
  n: number;
  pct: number;
}

export interface CategoricalVariableStats {
  kind: "categorical";
  n: number;
  missing: number;
  missingPct: number;
  frequencies: CategoricalFrequency[];
}

export interface TextOrDateVariableStats {
  kind: "other";
  n: number;
  missing: number;
  missingPct: number;
  uniqueCount: number;
}

export type VariableDescriptiveStats =
  | NumericVariableStats
  | CategoricalVariableStats
  | TextOrDateVariableStats;

export interface ComputedIntervalColumn {
  id: string;
  columnName: string;
  startVariableId: string;
  endVariableId: string;
  unit: "months" | "days";
}

/**
 * Parsea fechas en formato DD/MM/AAAA (estándar clínico) o ISO YYYY-MM-DD.
 */
export function parseClinicalDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();

  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    ) {
      return dt;
    }
    return null;
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

export function computeDateInterval(
  startRaw: unknown,
  endRaw: unknown,
  unit: "months" | "days"
): number | null {
  const d1 = parseClinicalDate(startRaw);
  const d2 = parseClinicalDate(endRaw);
  if (!d1 || !d2) return null;
  const diffMs = d2.getTime() - d1.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(diffDays)) return null;
  if (unit === "days") {
    return Math.round(diffDays);
  }
  // Convención bioestadística estándar: 1 mes = 30.4375 días (365.25 / 12)
  return Number((diffDays / 30.4375).toFixed(2));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function formatCellValueForDisplay(
  value: ExtractionRecord["value"] | undefined,
  missingPlaceholder = "NR"
): string {
  if (value === null || value === undefined) return missingPlaceholder;
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join("; ") : missingPlaceholder;
  }
  const str = String(value).trim();
  return str === "" ? missingPlaceholder : str;
}

export function isRecordPresent(record: ExtractionRecord | undefined): boolean {
  if (!record || record.status === "missing" || record.value === null || record.value === undefined) {
    return false;
  }
  if (Array.isArray(record.value)) return record.value.length > 0;
  return String(record.value).trim() !== "";
}

export function computeVariableStats(
  variable: StudyVariable,
  patients: Patient[],
  extractionIndex: Map<string, ExtractionRecord>
): VariableDescriptiveStats {
  const totalPatients = patients.length;
  const presentValues: ExtractionRecord["value"][] = [];

  for (const p of patients) {
    const rec = extractionIndex.get(`${p.id}::${variable.id}`);
    if (isRecordPresent(rec)) {
      presentValues.push(rec!.value);
    }
  }

  const n = presentValues.length;
  const missing = totalPatients - n;
  const missingPct = totalPatients > 0 ? Number(((missing / totalPatients) * 100).toFixed(1)) : 0;

  if (variable.type === "numeric") {
    const nums = presentValues
      .map((v) => (typeof v === "number" ? v : Number(String(v).replace(",", "."))))
      .filter((num) => Number.isFinite(num))
      .sort((a, b) => a - b);

    if (nums.length === 0) {
      return {
        kind: "numeric",
        n: 0,
        missing: totalPatients,
        missingPct: totalPatients > 0 ? 100 : 0,
        mean: null,
        sd: null,
        median: null,
        q1: null,
        q3: null,
        iqr: null,
        min: null,
        max: null,
      };
    }

    const mean = nums.reduce((acc, x) => acc + x, 0) / nums.length;
    const variance =
      nums.length > 1
        ? nums.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (nums.length - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const q1 = quantile(nums, 0.25);
    const median = quantile(nums, 0.5);
    const q3 = quantile(nums, 0.75);

    return {
      kind: "numeric",
      n: nums.length,
      missing: totalPatients - nums.length,
      missingPct:
        totalPatients > 0
          ? Number((((totalPatients - nums.length) / totalPatients) * 100).toFixed(1))
          : 0,
      mean: Number(mean.toFixed(2)),
      sd: Number(sd.toFixed(2)),
      median: Number(median.toFixed(2)),
      q1: Number(q1.toFixed(2)),
      q3: Number(q3.toFixed(2)),
      iqr: Number((q3 - q1).toFixed(2)),
      min: nums[0],
      max: nums[nums.length - 1],
    };
  }

  if (
    variable.type === "categorical_single" ||
    variable.type === "categorical_multiple" ||
    variable.type === "boolean"
  ) {
    const counts = new Map<string, number>();
    for (const val of presentValues) {
      if (Array.isArray(val)) {
        for (const item of val) {
          const clean = String(item).trim();
          if (clean) counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      } else {
        const clean = String(val).trim();
        if (clean) counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }

    const frequencies: CategoricalFrequency[] = Array.from(counts.entries())
      .map(([label, count]) => ({
        label,
        n: count,
        pct: n > 0 ? Number(((count / n) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.n - a.n);

    return {
      kind: "categorical",
      n,
      missing,
      missingPct,
      frequencies,
    };
  }

  const uniqueSet = new Set(presentValues.map((v) => String(v).trim()));
  return {
    kind: "other",
    n,
    missing,
    missingPct,
    uniqueCount: uniqueSet.size,
  };
}

export function computeRowCompleteness(
  patientId: string,
  variables: StudyVariable[],
  extractionIndex: Map<string, ExtractionRecord>
): number {
  if (variables.length === 0) return 0;
  let present = 0;
  for (const v of variables) {
    if (isRecordPresent(extractionIndex.get(`${patientId}::${v.id}`))) {
      present += 1;
    }
  }
  return Math.round((present / variables.length) * 100);
}
