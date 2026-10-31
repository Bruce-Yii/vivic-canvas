const fileFormats: Record<string, string> = {
  "application/pdf": "PDF",
  "text/markdown": "MD",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "application/json": "JSON",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

export const fileFormatLabel = (mediaType: string) => fileFormats[mediaType] ?? "FILE";
