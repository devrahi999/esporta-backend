import { LoginThrottleService } from './login-throttle.service';
import type { AppConfigService } from '../config/app-config.service';

// The service's only runtime imports from Nest are the (test-irrelevant)
// @Injectable decorator and the config service's class token; mocking both
// keeps this a pure-logic spec without pulling Nest's ESM builds into the CJS
// jest transform.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (): void => undefined,
}));
jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigServiceMock {},
}));

/**
 * PHASE 14 (STEP 2): account-level sign-in backoff.
 *
 * Covers the mandatory authentication cases from the STEP 2 brief:
 * repeated failures against ONE account, backoff progression, cap, eventual
 * recovery after waiting, success reset, and isolation between accounts.
 * (Per-IP throttling lives in the STEP 1 tier guard and is verified live.)
 */
const SETTINGS = {
  initialDelayMs: 2_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  failureWindowMs: 900_000,
  accountThreshold: 5,
};

function makeService(): LoginThrottleService {
  return new LoginThrottleService({
    rateLimit: { loginBackoff: SETTINGS },
  } as unknown as AppConfigService);
}

describe('LoginThrottleService', () => {
  it('does not delay before the failure threshold (legitimate typo territory)', () => {
    const svc = makeService();
    const t = 1_000_000;
    for (let i = 0; i < SETTINGS.accountThreshold - 1; i++) {
      svc.recordFailure('user@example.com', t);
    }
    expect(svc.delayFor('user@example.com', t)).toBe(0);
  });

  it('engages the initial delay at the threshold and grows exponentially', () => {
    const svc = makeService();
    let t = 1_000_000;
    for (let i = 0; i < SETTINGS.accountThreshold; i++) {
      svc.recordFailure('user@example.com', t);
      t += 100; // attacker hammering
    }
    // 5th failure: initial delay. 6th: x2. 7th: x4.
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThanOrEqual(SETTINGS.initialDelayMs - 100);
    svc.recordFailure('user@example.com', t);
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThanOrEqual(SETTINGS.initialDelayMs * 2 - 100);
    svc.recordFailure('user@example.com', t);
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThanOrEqual(SETTINGS.initialDelayMs * 4 - 100);
  });

  it('caps the delay at maxDelayMs (no permanent lockout)', () => {
    const svc = makeService();
    let t = 1_000_000;
    for (let i = 0; i < 50; i++) {
      svc.recordFailure('user@example.com', t);
      t += 10;
    }
    const delay = svc.delayFor('user@example.com', t);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(SETTINGS.maxDelayMs);
  });

  it('fully recovers after the failure window passes with no attempts', () => {
    const svc = makeService();
    let t = 1_000_000;
    for (let i = 0; i < 20; i++) {
      svc.recordFailure('user@example.com', t);
      t += 100;
    }
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThan(0);

    const quietLongEnough = t + SETTINGS.failureWindowMs + 1;
    expect(svc.delayFor('user@example.com', quietLongEnough)).toBe(0);

    // And a fresh failure starts a clean count, not a continuation.
    svc.recordFailure('user@example.com', quietLongEnough);
    expect(svc.delayFor('user@example.com', quietLongEnough)).toBe(0);
  });

  it('resets immediately on a successful sign-in', () => {
    const svc = makeService();
    let t = 1_000_000;
    for (let i = 0; i < SETTINGS.accountThreshold; i++) {
      svc.recordFailure('user@example.com', t);
      t += 100;
    }
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThan(0);
    svc.recordSuccess('user@example.com');
    expect(svc.delayFor('user@example.com', t)).toBe(0);
  });

  it('normalizes email case/whitespace so attacker variations share one bucket', () => {
    const svc = makeService();
    const t = 1_000_000;
    for (let i = 0; i < SETTINGS.accountThreshold; i++) {
      // Rotate spellings the way an enumeration script would.
      const email = ['User@Example.com', '  user@example.com ', 'USER@EXAMPLE.COM'][i % 3];
      svc.recordFailure(email, t);
    }
    expect(svc.delayFor('user@example.com', t)).toBeGreaterThanOrEqual(SETTINGS.initialDelayMs - 100);
  });

  it('isolates accounts: failing against one never delays another', () => {
    const svc = makeService();
    let t = 1_000_000;
    for (let i = 0; i < 20; i++) {
      svc.recordFailure('victim@example.com', t);
      t += 100;
    }
    expect(svc.delayFor('victim@example.com', t)).toBeGreaterThan(0);
    expect(svc.delayFor('bystander@example.com', t)).toBe(0);
  });

  it('treats failures outside the window as unrelated (no eternal accumulation)', () => {
    const svc = makeService();
    const t0 = 1_000_000;
    for (let i = 0; i < SETTINGS.accountThreshold - 1; i++) {
      svc.recordFailure('user@example.com', t0 + i * 100);
    }
    // Long silence beyond the window *counting from the newest old failure*
    // (t0 + 300), then more failures: the old ones must not count.
    const later = t0 + SETTINGS.failureWindowMs + 1_000;
    for (let i = 0; i < SETTINGS.accountThreshold - 1; i++) {
      svc.recordFailure('user@example.com', later + i * 100);
    }
    expect(svc.delayFor('user@example.com', later + 10_000)).toBe(0);
  });
});
