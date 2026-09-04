/**
 * Stable, machine-readable error codes returned in the API envelope
 * (`error.code`). Flutter switches on these, so treat them as a contract:
 * add new ones, never repurpose an existing string.
 *
 * Domain-specific codes (e.g. RECRUITMENT_CLOSED) live alongside their feature
 * module; this file holds the cross-cutting ones.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_ANALYTICS_EVENT: 'INVALID_ANALYTICS_EVENT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  PROFILE_FORBIDDEN: 'PROFILE_FORBIDDEN',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * A code/alert was minted server-side but SMTP would not accept the message,
   * so the user never received it. Distinct from UPSTREAM_ERROR because the
   * security operation itself succeeded — only delivery failed.
   */
  EMAIL_DELIVERY_FAILED: 'EMAIL_DELIVERY_FAILED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | string;
