import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import z, { ZodError } from "zod";
import { MulterError } from "multer";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  /** Map known failures to safe public errors and delegate responses already started. */
  if (response.headersSent) {
    next(error);
    return;
  }

  let statusCode = 500;
  let code = "INTERNAL_SERVER_ERROR";
  let message = "Something went wrong while processing the request.";
  let details: unknown;

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
    details = error.details ?? null;
  } else if (error instanceof ZodError) {
    statusCode = 422;
    code = "VALIDATION_ERROR";
    message = "Some supplied values are invalid.";
    details = z.flattenError(error).fieldErrors;
  } else if (error instanceof MulterError) {
    const tooLarge =
      error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FIELD_VALUE";
    statusCode = tooLarge ? 413 : 400;
    code = tooLarge ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD";
    message = tooLarge
      ? "The uploaded file or field is too large."
      : "The upload does not match the expected files and fields.";
  } else if (error instanceof Error && "type" in error && "status" in error) {
    // Recognize JSON parser failures without echoing their messages or body.
    if (error.type === "entity.parse.failed" && error.status === 400) {
      statusCode = 400;
      code = "INVALID_JSON";
      message = "The request body must be valid JSON.";
    } else if (error.type === "entity.too.large" && error.status === 413) {
      statusCode = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "The request body is too large.";
    }
  } else if (error instanceof Error && "status" in error && "code" in error
    && error.status === 400 && ["Z_DATA_ERROR", "Z_BUF_ERROR"].includes(String(error.code))) {
    // Malformed gzip streams surface directly from zlib instead of body-parser's typed JSON errors.
    statusCode = 400;
    code = "INVALID_REQUEST_ENCODING";
    message = "The compressed request body is invalid.";
  }

  // Parser errors may hold CV text in both message and body. Log only the
  // classification; the request logger already supplies its request ID.
  request.log?.error({ code, statusCode }, "Request failed");

  response.status(statusCode).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
};
