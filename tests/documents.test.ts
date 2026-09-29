import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { chunkDocumentText, extractDocument, rankChunks } from "../src/documents/extract";

describe("document extraction", () => {
  it("extracts TXT with normalization and limit", async () => {
    const result = await extractDocument(
      new TextEncoder().encode("  hello   world\n\n\nsecond line  ").buffer,
      "txt",
      env.DB,
    );
    expect(result.text).toBe("hello world\n\nsecond line");
    expect(result.fileType).toBe("txt");
  });

  it("extracts DOCX text from word/document.xml without storing binary payload", async () => {
    const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; Docs</w:t></w:r></w:p></w:body></w:document>';
    const bytes = zipSync({ "word/document.xml": strToU8(xml) });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const result = await extractDocument(buffer, "docx", env.DB);
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World & Docs");
  });

  it("chunks with bounded overlap and ranks the best excerpts", () => {
    const chunks = chunkDocumentText("alpha beta gamma ".repeat(200), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);

    const ranked = rankChunks(
      [
        { id: "a", content: "banana apple fruit" },
        { id: "b", content: "cloudflare queue telegram" },
        { id: "c", content: "telegram cloudflare security" },
      ],
      "cloudflare telegram",
      2,
    );
    expect(ranked.map((row) => row.id)).toEqual(["b", "c"]);
  });
});