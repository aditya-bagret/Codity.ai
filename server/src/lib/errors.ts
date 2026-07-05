/**
 * Application error carrying an HTTP status and a machine-readable code.
 * The API error middleware serializes these as { error: { code, message, details } }.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "BAD_REQUEST", message, details);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(400, "VALIDATION_ERROR", message, details);
  }

  static unauthorized(message = "authentication required"): ApiError {
    return new ApiError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "insufficient permissions"): ApiError {
    return new ApiError(403, "FORBIDDEN", message);
  }

  static notFound(what = "resource"): ApiError {
    return new ApiError(404, "NOT_FOUND", `${what} not found`);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, "CONFLICT", message, details);
  }
}
