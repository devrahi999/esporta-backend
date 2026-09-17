/**
 * The single API response shape (plan.md §30). Every successful response is
 * `{ success: true, data, error: null, meta }`; every error is
 * `{ success: false, data: null, error: { code, message }, meta }`.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiMeta {
  requestId?: string;
  [key: string]: unknown;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  meta: ApiMeta;
}

export function apiOk<T>(data: T, meta: ApiMeta = {}): ApiResponse<T> {
  return { success: true, data, error: null, meta };
}

export function apiFail(error: ApiErrorBody, meta: ApiMeta = {}): ApiResponse<null> {
  return { success: false, data: null, error, meta };
}

/**
 * Marker a controller can return to hand back a fully-formed envelope (usually
 * with `meta`, e.g. pagination) without the interceptor wrapping it again.
 */
export const ENVELOPE = Symbol('esporta.envelope');
export type Enveloped<T> = ApiResponse<T> & { [ENVELOPE]: true };

export function enveloped<T>(data: T, meta: ApiMeta = {}): Enveloped<T> {
  return { ...apiOk(data, meta), [ENVELOPE]: true };
}

export function isEnveloped(value: unknown): value is Enveloped<unknown> {
  return typeof value === 'object' && value !== null && ENVELOPE in value;
}
