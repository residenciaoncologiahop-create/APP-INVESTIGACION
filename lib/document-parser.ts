"use client";

import type { ClinicalDocument, DocumentCategory } from "./types";

export const MIN_SELECTABLE_TEXT_LENGTH = 30;

export const SCANNED_PDF_WARNING =
  "Este PDF parece una imagen escaneada sin texto seleccionable";

export interface ParsedClinicalFile {
  filename: string;
  fileType: "pdf" | "docx" | "txt";
  fileSize: number;
  category: DocumentCategory;
  text: string;
  pageCount?: number;
  extractedCharCount: number;
  isLowTextPdf: boolean;
  warning?: string;
}

export function countMeaningfulClinicalChars(rawText: string): number {
  return (rawText || "")
    .replace(/---\s*Página siguiente\s*---/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

export function evaluateExtractedPdfText(rawText: string): {
  extractedCharCount: number;
  isLowTextPdf: boolean;
  warning?: string;
} {
  const extractedCharCount = countMeaningfulClinicalChars(rawText);
  const isLowTextPdf = extractedCharCount < MIN_SELECTABLE_TEXT_LENGTH;
  return {
    extractedCharCount,
    isLowTextPdf,
    warning: isLowTextPdf ? SCANNED_PDF_WARNING : undefined,
  };
}

export function isDocumentLowTextPdf(doc: Pick<ClinicalDocument, "fileType" | "rawText" | "isLowTextPdf">): boolean {
  if (doc.fileType !== "pdf") return false;
  if (doc.isLowTextPdf === true) return true;
  return countMeaningfulClinicalChars(doc.rawText) < MIN_SELECTABLE_TEXT_LENGTH;
}

export function inferDocumentCategory(filename: string): DocumentCategory {
  const lower = filename.toLowerCase();
  if (/patol|biops|anatom|ihq|ngs|molec/.test(lower)) return "patologia";
  if (/epicris|alta|egreso|defunc/.test(lower)) return "epicrisis";
  if (/tac|tc_|pet|rmn|reson|tomog|imag|eco|rx/.test(lower)) return "imagenes";
  if (/quimio|proto|esquema|infus|trat|radio/.test(lower)) return "tratamiento";
  if (/evol|consul|seguim|ambulat|hcd|hc_/.test(lower)) return "evolucion";
  return "otro";
}

export function inferPatientGroupKey(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  // Si el archivo empieza con un código o ID (ej. "P001_Epicrisis" o "12345-Patologia"), agrupamos por el prefijo
  const match = stem.match(/^([A-Za-z]{1,6}[-_]?\d{1,6}|\d{4,10})/);
  if (match) {
    return match[1].toUpperCase();
  }
  return stem;
}

async function parsePdfFile(file: File): Promise<{
  text: string;
  pageCount: number;
  extractedCharCount: number;
  isLowTextPdf: boolean;
  warning?: string;
}> {
  const pdfjsLib = await import("pdfjs-dist");
  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let lastY: number | null = null;
    let currentLine = "";

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const textItem = item as { str: string; transform?: number[] };
      const y = textItem.transform ? Math.round(textItem.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = textItem.str;
      } else {
        currentLine += (currentLine && !currentLine.endsWith(" ") ? " " : "") + textItem.str;
      }
      lastY = y;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    pageTexts.push(lines.join("\n"));
  }

  const combined = pageTexts.join("\n\n--- Página siguiente ---\n\n").trim();
  const evaluation = evaluateExtractedPdfText(combined);

  // Conservamos el documento aunque tenga menos de 30 caracteres para que el médico
  // vea la alerta de PDF escaneado en la tarjeta del paciente (sin afirmar OCR).
  return {
    text: combined,
    pageCount: pdf.numPages,
    ...evaluation,
  };
}

async function parseDocxFile(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

export async function parseClinicalFile(file: File): Promise<ParsedClinicalFile> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const category = inferDocumentCategory(file.name);

  if (ext === "pdf") {
    const { text, pageCount, extractedCharCount, isLowTextPdf, warning } =
      await parsePdfFile(file);
    return {
      filename: file.name,
      fileType: "pdf",
      fileSize: file.size,
      category,
      text,
      pageCount,
      extractedCharCount,
      isLowTextPdf,
      warning,
    };
  }

  if (ext === "docx") {
    const text = await parseDocxFile(file);
    if (!text) {
      throw new Error(`El archivo Word "${file.name}" está vacío.`);
    }
    return {
      filename: file.name,
      fileType: "docx",
      fileSize: file.size,
      category,
      text,
      extractedCharCount: countMeaningfulClinicalChars(text),
      isLowTextPdf: false,
    };
  }

  if (ext === "txt" || ext === "md" || ext === "csv" || file.type.startsWith("text/")) {
    const text = (await file.text()).trim();
    if (!text) {
      throw new Error(`El archivo de texto "${file.name}" está vacío.`);
    }
    return {
      filename: file.name,
      fileType: "txt",
      fileSize: file.size,
      category,
      text,
      extractedCharCount: countMeaningfulClinicalChars(text),
      isLowTextPdf: false,
    };
  }

  throw new Error(
    `Formato no soportado para "${file.name}". Utilizá archivos PDF, Word (.docx) o texto (.txt).`
  );
}
