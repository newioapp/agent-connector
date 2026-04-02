/** Error codes matching the server's error classes. */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'WAITLIST_PENDING'
  | 'INTERNAL';

/** Base error for all SDK errors. */
export class NewioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewioError';
  }
}

/** HTTP API error with status code and error code from the backend. */
export class ApiError extends NewioError {
  readonly statusCode: number;
  readonly errorCode: ErrorCode;
  readonly body: unknown;

  constructor(statusCode: number, errorCode: ErrorCode, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.body = body;
  }

  /** Parse a server error response into the appropriate ApiError subclass. */
  static fromResponse(statusCode: number, body: unknown): ApiError {
    const parsed = body as Partial<{ error: string; errorCode: ErrorCode }> | null;
    const errorCode = parsed?.errorCode ?? 'INTERNAL';
    const message = parsed?.error ?? `HTTP ${statusCode}`;

    switch (errorCode) {
      case 'INVALID_REQUEST':
        return new InvalidRequestApiError(message, body);
      case 'UNAUTHENTICATED':
        return new UnauthenticatedApiError(message, body);
      case 'FORBIDDEN':
        return new ForbiddenApiError(message, body);
      case 'NOT_FOUND':
        return new NotFoundApiError(message, body);
      case 'CONFLICT':
        return new ConflictApiError(message, body);
      case 'WAITLIST_PENDING':
        return new WaitlistPendingApiError(message, body);
      default:
        return new ApiError(statusCode, errorCode, message, body);
    }
  }
}

/** 400 — malformed request, missing fields, invalid values. */
export class InvalidRequestApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(400, 'INVALID_REQUEST', message, body);
    this.name = 'InvalidRequestApiError';
  }
}

/** 401 — missing or invalid credentials. */
export class UnauthenticatedApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(401, 'UNAUTHENTICATED', message, body);
    this.name = 'UnauthenticatedApiError';
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(403, 'FORBIDDEN', message, body);
    this.name = 'ForbiddenApiError';
  }
}

/** 404 — resource not found. */
export class NotFoundApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(404, 'NOT_FOUND', message, body);
    this.name = 'NotFoundApiError';
  }
}

/** 409 — conflict (e.g. duplicate resource). */
export class ConflictApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(409, 'CONFLICT', message, body);
    this.name = 'ConflictApiError';
  }
}

/** 403 — user is on the waitlist and not yet approved. */
export class WaitlistPendingApiError extends ApiError {
  constructor(message: string, body: unknown) {
    super(403, 'WAITLIST_PENDING', message, body);
    this.name = 'WaitlistPendingApiError';
  }
}

/** Thrown when the approval flow times out or is rejected. */
export class ApprovalTimeoutError extends NewioError {
  constructor() {
    super('Approval timed out or was not completed.');
    this.name = 'ApprovalTimeoutError';
  }
}

/** Thrown when a token refresh fails. */
export class TokenRefreshError extends NewioError {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}
