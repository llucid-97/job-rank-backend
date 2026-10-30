export class PdfExtractionError extends Error {
  constructor(message = "The PDF could not be parsed.") {
    super(message);
    this.name = "PdfExtractionError";
  }
}
