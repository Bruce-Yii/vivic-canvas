import { expect, it, vi } from "vitest";
import { FILE_ACCEPT, readOriginalText, validateFileBatch } from "./parse";

it("accepts only PDF and Markdown for new uploads, keeping batch limits", () => {
  expect(FILE_ACCEPT).toBe(".md,.pdf");
  expect(() => validateFileBatch([new File(["# Note"], "Note.MD"), new File(["%PDF"], "book.pdf")])).not.toThrow();
  for (const extension of ["docx", "doc", "txt", "json", "csv"]) {
    expect(() => validateFileBatch([new File(["legacy"], `file.${extension}`)])).toThrow("只支持 PDF 和 Markdown");
  }
  expect(() => validateFileBatch(Array.from({ length: 6 }, () => new File(["x"], "a.md")))).toThrow("最多 5 个");
  expect(() => validateFileBatch([new File([new Uint8Array(6_000_000)], "a.md"), new File([new Uint8Array(4_000_001)], "b.pdf")])).toThrow("合计不超过 10 MB");
});

it("never decodes a legacy Word original, even when called directly", async () => {
  const bytes = vi.fn();
  expect(await readOriginalText({ arrayBuffer: bytes } as unknown as Blob, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
    .toEqual({ text: "", parseStatus: "unsupported" });
  expect(bytes).not.toHaveBeenCalled();
});
