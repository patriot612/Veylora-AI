import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { getSystemConfigInt } from "../config";

export type ExtractedDocument = {
  fileType: "pdf" | "docx" | "txt";
  text: string;
  pages?: number;
};

export async function extractDocument(
  bytes: ArrayBuffer,
  fileType: ExtractedDocument["fileType"],
  db: D1Database,
): Promise<ExtractedDocument> {
  const maxBytes = await getSystemConfigInt(db, "limits.document_bytes", 10 * 1024 * 1024);
  if (bytes.byteLength > maxBytes) throw new Error("document_too_large");

  const maxChars = await getSystemConfigInt(db, "limits.document_extracted_chars", 25_000);

  if (fileType === "txt") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { fileType, text: normalizeText(text).slice(0, maxChars) };
  }

  if (fileType === "docx") {
    const files = unzipSync(new Uint8Array(bytes));
    const documentXml = files["word/document.xml"];
    if (!documentXml) throw new Error("docx_document_xml_missing");
    const xml = new TextDecoder().decode(documentXml);
    const text = extractDocxText(xml);
    return { fileType, text: normalizeText(text).slice(0, maxChars) };
  }

  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const maxPages = await getSystemConfigInt(db, "limits.document_pdf_pages", 50);
  if (pdf.numPages > maxPages) {
    await pdf.loadingTask.destroy();
    throw new Error("document_pdf_page_limit");
  }

  const { text: pageTexts } = await extractText(pdf);
  const text = (pageTexts as string[]).slice(0, maxPages).join("\n");
  const pageCount = pdf.numPages;
  await pdf.loadingTask.destroy();
  return { fileType, pages: pageCount, text: normalizeText(text).slice(0, maxChars) };
}

export function chunkDocumentText(text: string, size = 2000, overlap = 200): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function rankChunks(chunks: Array<{ id: string; content: string }>, query: string, limit = 6) {
  const terms = tokenize(query);
  return chunks
    .map((chunk) => {
      const words = new Set(tokenize(chunk.content));
      const score = terms.reduce((sum, term) => sum + (words.has(term) ? 1 : 0), 0);
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function extractDocxText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/>/g, " ")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
}

function normalizeText(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase("ru-RU").split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
}