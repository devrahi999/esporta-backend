import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';

/**
 * Account-level login backoff (STEP 2, PHASE 3).
 *
 * STEP 1's tier guard throttles per (tier, client IP) — it cannot stop a
 * distributed attacker rotating IPs against ONE account, and an IP limit alone
 * punishes users behind CGNATs. This service adds the missing axis: progressive
 * delays keyed by the TARGET account, so repeated failed sign-ins against the
 * same account get exponentially slower no matter where they come from.
 *
 * Design constraints honored here:
 * - No permanent lockout: delays cap at `maxDelayMs` and fully expire once the
 *   failure window passes — a victim is never permanently locked out of their
 *   own account, and a legitimate user who mistypes five times waits at most
 *   `maxDelayMs`, not forever.
 * - Keys never contain raw identifiers: the key is SHA-256 of the normalized
 *   email (trim + lowercase, matching Supabase's own normalization). No
 *   password material is ever seen by this class — it receives the email only,
 *   and hashes it before storage (privacy: a heap dump never yields a list of
 *   user emails; security: no credential can leak into a cache key).
 * - Backend-authoritative and invisible in UX: the delay is enforced BEFORE
 *   the credential check, returning the standard RATE_LIMITED envelope.
 *
 * Honesty note (STEP 1 finding carried forward): storage is in-process memory,
 * so like every counter in this API it is per serverless instance, not a
 * global quota. It still closes the account-rotation gap in practice — the
 * key is stable across attacker IPs and warm instances are the hot path — but
 * global enforcement remains an operational dependency (see STEP 2 report,
 * PHASE 4). Swapping the two Maps for a shared store is a contained change:
 * this class is the ONLY touchpoint for account-level auth state.
 */
@Injectable()
export class LoginThrottleService {
  /** sha256(normalized email) → state. Hashed so memory never holds raw emails. */
  private readonly accounts = new Map<string, AccountFailures>();
  /** Buffered sweep deadline so we do not scan the map on every request. */
  private nextSweepAt = 0;

  constructor(private readonly config: AppConfigService) {}

  private get settings() {
    return this.config.rateLimit.loginBackoff;
  }

  /**
   * How long the NEXT sign-in attempt for this account must wait, in ms.
   * 0 = no backoff; a positive value is the enforced delay from now.
   */
  delayFor(email: string, now: number = Date.now()): number {
    this.sweepIfNeeded(now);
    const state = this.accounts.get(this.keyOf(email));
    if (!state) return 0;

    // Window expired: a quiet account is a clean slate (no permanent record).
    if (now - state.lastFailureAt > this.settings.failureWindowMs) {
      this.accounts.delete(this.keyOf(email));
      return 0;
    }
    if (state.blockedUntil <= now) return 0;
    return state.blockedUntil - now;
  }

  /**
   * Records a failed sign-in. Fails below `accountThreshold` are free (normal
   * typo territory); from the threshold on, each failure multiplies the delay,
   * capped at `maxDelayMs`.
   */
  recordFailure(email: string, now: number = Date.now()): void {
    const key = this.keyOf(email);
    const state = this.accounts.get(key);

    if (!state || now - state.lastFailureAt > this.settings.failureWindowMs) {
      this.accounts.set(key, { failures: 1, lastFailureAt: now, blockedUntil: 0 });
      return;
    }

    state.failures += 1;
    state.lastFailureAt = now;
    if (state.failures < this.settings.accountThreshold) {
      return;
    }
    const exponent = state.failures - this.settings.accountThreshold;
    const delay = Math.min(
      this.settings.initialDelayMs * this.settings.multiplier ** exponent,
      this.settings.maxDelayMs,
    );
    state.blockedUntil = now + delay;
    this.nextSweepAt = 0; // force a sweep soon; map just grew a live entry
  }

  /** Successful authentication wipes the account's slate immediately. */
  recordSuccess(email: string): void {
    this.accounts.delete(this.keyOf(email));
  }

  /** Normalized the same way Supabase normalizes login emails. */
  private keyOf(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  /** Amortized prune: bounded memory even under randomized-enum floods. */
  private sweepIfNeeded(now: number): void {
    if (now < this.nextSweepAt) return;
    const cutoff = now - this.settings.failureWindowMs;
    for (const [key, state] of this.accounts) {
      if (state.lastFailureAt < cutoff) this.accounts.delete(key);
    }
    this.nextSweepAt = now + 60_000;
  }
}

interface AccountFailures {
  failures: number;
  lastFailureAt: number;
  /** Epoch ms until which sign-ins are refused; 0 = not currently delayed. */
  blockedUntil: number;
}