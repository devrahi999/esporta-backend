import type { Request } from 'express';

/**
 * The authenticated user resolved from the Supabase JWT (never from client
 * input). Populated by the auth guard; `claims` keeps the raw verified payload.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  role?: string;
  sessionId?: string;
  claims: Record<string, unknown>;
}

/**
 * Per-request context attached to the Express request. `requestId` is set by the
 * request-id middleware; the auth fields are filled in by the auth / active-
 * profile guards downstream.
 */
export interface EsportaRequestContext {
  requestId: string;
  accessToken?: string;
  user?: AuthenticatedUser;
  activeProfileId?: string;
}

export interface EsportaRequest extends Request {
  esporta: EsportaRequestContext;
}

/** Ensures and returns the context bag on a request. */
export function contextOf(req: Request): EsportaRequestContext {
  const r = req as EsportaRequest;
  if (!r.esporta) {
    r.esporta = { requestId: '' };
  }
  return r.esporta;
}
