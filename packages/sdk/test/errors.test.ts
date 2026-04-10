import { describe, it, expect } from 'vitest';
import {
  ApiError,
  InvalidRequestApiError,
  UnauthenticatedApiError,
  ForbiddenApiError,
  NotFoundApiError,
  ConflictApiError,
  WaitlistPendingApiError,
  ApprovalTimeoutError,
  TokenRefreshError,
  NewioError,
} from '../src/core/errors.js';

describe('errors', () => {
  describe('ApiError.fromResponse', () => {
    it('returns InvalidRequestApiError for INVALID_REQUEST', () => {
      const err = ApiError.fromResponse(400, { error: 'bad field', errorCode: 'INVALID_REQUEST' });
      expect(err).toBeInstanceOf(InvalidRequestApiError);
      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('INVALID_REQUEST');
      expect(err.message).toBe('bad field');
    });

    it('returns UnauthenticatedApiError for UNAUTHENTICATED', () => {
      const err = ApiError.fromResponse(401, { error: 'no token', errorCode: 'UNAUTHENTICATED' });
      expect(err).toBeInstanceOf(UnauthenticatedApiError);
      expect(err.statusCode).toBe(401);
    });

    it('returns ForbiddenApiError for FORBIDDEN', () => {
      const err = ApiError.fromResponse(403, { error: 'denied', errorCode: 'FORBIDDEN' });
      expect(err).toBeInstanceOf(ForbiddenApiError);
      expect(err.statusCode).toBe(403);
    });

    it('returns NotFoundApiError for NOT_FOUND', () => {
      const err = ApiError.fromResponse(404, { error: 'gone', errorCode: 'NOT_FOUND' });
      expect(err).toBeInstanceOf(NotFoundApiError);
      expect(err.statusCode).toBe(404);
    });

    it('returns ConflictApiError for CONFLICT', () => {
      const err = ApiError.fromResponse(409, { error: 'dup', errorCode: 'CONFLICT' });
      expect(err).toBeInstanceOf(ConflictApiError);
      expect(err.statusCode).toBe(409);
    });

    it('returns WaitlistPendingApiError for WAITLIST_PENDING', () => {
      const err = ApiError.fromResponse(403, { error: 'wait', errorCode: 'WAITLIST_PENDING' });
      expect(err).toBeInstanceOf(WaitlistPendingApiError);
      expect(err.statusCode).toBe(403);
      expect(err.errorCode).toBe('WAITLIST_PENDING');
    });

    it('returns generic ApiError for unknown errorCode', () => {
      const err = ApiError.fromResponse(500, { error: 'boom', errorCode: 'INTERNAL' });
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(500);
      expect(err.errorCode).toBe('INTERNAL');
    });

    it('handles null body', () => {
      const err = ApiError.fromResponse(500, null);
      expect(err.errorCode).toBe('INTERNAL');
      expect(err.message).toBe('HTTP 500');
    });

    it('handles body without errorCode', () => {
      const err = ApiError.fromResponse(502, { error: 'gateway' });
      expect(err.errorCode).toBe('INTERNAL');
      expect(err.message).toBe('gateway');
    });
  });

  describe('error names', () => {
    it('sets correct name on each subclass', () => {
      expect(new NewioError('x').name).toBe('NewioError');
      expect(new InvalidRequestApiError('x', {}).name).toBe('InvalidRequestApiError');
      expect(new UnauthenticatedApiError('x', {}).name).toBe('UnauthenticatedApiError');
      expect(new ForbiddenApiError('x', {}).name).toBe('ForbiddenApiError');
      expect(new NotFoundApiError('x', {}).name).toBe('NotFoundApiError');
      expect(new ConflictApiError('x', {}).name).toBe('ConflictApiError');
      expect(new WaitlistPendingApiError('x', {}).name).toBe('WaitlistPendingApiError');
      expect(new ApprovalTimeoutError().name).toBe('ApprovalTimeoutError');
      expect(new TokenRefreshError('x').name).toBe('TokenRefreshError');
    });
  });

  describe('ApprovalTimeoutError', () => {
    it('has a descriptive message', () => {
      const err = new ApprovalTimeoutError();
      expect(err.message).toBe('Approval timed out or was not completed.');
    });
  });

  describe('TokenRefreshError', () => {
    it('preserves the message', () => {
      const err = new TokenRefreshError('refresh failed');
      expect(err.message).toBe('refresh failed');
    });
  });
});
