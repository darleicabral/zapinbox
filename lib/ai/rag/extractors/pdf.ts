/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * Primary: pdf-parse (fast, handles most PDFs).
 * Fallback: pdfjs-dist legacy build (handles layout-heavy/scanned PDFs).
 * Both fail → throws PdfExtractError.
 */

import type * as PdfjsDist from "pdfjs-dist";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/**
 * Extracts plain text from a PDF buffer.
 * Tries pdf-parse first; falls back to pdfjs-dist on failure.
 * Throws `PdfExtractError` if both strategies fail.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  // --- Primary: pdf-parse ---
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    if (text.length > 0) return text;
    // Empty text from pdf-parse — may be an image-only PDF; fall through to pdfjs
    console.warn("[pdf-extract] pdf-parse returned empty text — trying pdfjs fallback");
  } catch (err) {
    console.warn("[pdf-extract] pdf-parse failed, trying pdfjs-dist fallback:", err);
  }

  // --- Fallback: pdfjs-dist legacy build ---
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js") as typeof PdfjsDist;

    // Disable the worker for server-side Node usage (no DOM/worker thread)
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "";
    }

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdfDocument = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      if (pageText.length > 0) pageTexts.push(pageText);
    }

    const combined = pageTexts.join("\n\n").trim();
    if (combined.length === 0) {
      throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)");
    }
    return combined;
  } catch (err) {
    if (err instanceof PdfExtractError) throw err;
    throw new PdfExtractError("Both pdf-parse and pdfjs-dist failed to extract text", err);
  }
}
