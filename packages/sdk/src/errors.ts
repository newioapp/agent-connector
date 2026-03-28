/** Base error for all SDK errors. */
export class NewioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewioError';
  }
}

/** HTTP API error with status code and optional error code from the backend. */
export class ApiError extends NewioError {
  readonly statusCode: number;
  readonly errorCode?: string;

  constructor(statusCode: number, message: string, errorCode?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }

  static fromResponse(statusCode: number, body: unknown): ApiError {
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      const message = typeof record['message'] === 'string' ? record['message'] : `HTTP ${statusCode}`;
      const errorCode = typeof record['errorCode'] === 'string' ? record['errorCode'] : undefined;
      return new ApiError(statusCode, message, errorCode);
    }
    return new ApiError(statusCode, `HTTP ${statusCode}`);
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
