import { AppException } from './app-exception';

/**
 * Turns a Postgres eligibility refusal into a sentence, keyed on the `hint` the
 * guard raised.
 *
 * The rules themselves live in triggers — `guard_team_member_capability`,
 * `guard_tryout_capability`, `guard_application_capability`,
 * `guard_official_role` — because each is a rule about rows in another table and a
 * trigger covers every write path at once: this API, an RPC, a psql session. That
 * is the point of not trusting a client. What a trigger cannot do is phrase itself
 * for a user, and `check_violation` reaches the client verbatim, so a raw
 * `violates check constraint` string would be what somebody read on screen.
 *
 * Anything unrecognised is rethrown untouched: this only renames refusals it knows.
 */
const MESSAGES: Record<string, string> = {
  role_cannot_join_team:
    'This profile type cannot hold a roster place. Only players, coaches, ' +
    'managers and analysts can join a team.',
  role_cannot_tryout: 'Only a player profile can be given a tryout.',
  sponsorship_has_no_tryout:
    'A sponsorship has no tryout. Approve or reject it instead.',
  no_sponsor_side:
    'Neither of these profiles can act as a sponsor. Sponsorship runs between a ' +
    'creator and the profile they sponsor.',
  not_sponsorable: 'This profile cannot be sponsored.',
  official_role_only:
    'That is not one of the official professional roles.',
  official_category_only: 'That profile type is not available yet.',
};

/** The client-facing code for every eligibility refusal. */
export const ELIGIBILITY_CODE = 'ROLE_NOT_ELIGIBLE';

export function describeEligibilityFailure(error: unknown): unknown {
  const hint = eligibilityHint(error);
  if (hint === null) return error;
  return AppException.unprocessable(MESSAGES[hint], ELIGIBILITY_CODE, { hint });
}

/** The recognised hint on this error, or null. */
export function eligibilityHint(error: unknown): string | null {
  if (!(error instanceof AppException)) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const hint = (details as { hint?: unknown }).hint;
  if (typeof hint !== 'string') return null;
  return hint in MESSAGES ? hint : null;
}
