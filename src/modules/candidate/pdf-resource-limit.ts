export class PdfResourceLimitError extends Error {
  constructor(message = "The PDF exceeds supported extraction limits.") {
    super(message);
    this.name = "PdfResourceLimitError";
  }
}
