import { AppException } from './app-exception';
import { ELIGIBILITY_CODE, describeEligibilityFailure, eligibilityHint } from './eligibility';

/**
 * The eligibility rules live in Postgres triggers, which is the right place for a
 * rule about rows in another table. What that leaves for this layer is naming the
 * refusal — and `check_violation` reaches the client verbatim, so getting this
 * wrong means a user reads a constraint name.
 */
describe('describeEligibilityFailure', () => {
  const refusal = (hint: string) =>
    AppException.unprocessable('new row violates check constraint', 'UNPROCESSABLE', {
      code: '23514',
      hint,
    });

  it.each([
    'role_cannot_join_team',
    'role_cannot_tryout',
    'sponsorship_has_no_tryout',
    'no_sponsor_side',
    'not_sponsorable',
    'official_role_only',
    'official_category_only',
  ])('renames the %s refusal', (hint) => {
    const mapped = describeEligibilityFailure(refusal(hint)) as AppException;

    expect(mapped).toBeInstanceOf(AppException);
    expect(mapped.getStatus()).toBe(422);
    expect(mapped.code).toBe(ELIGIBILITY_CODE);
    expect(mapped.message).not.toContain('constraint');
    expect(mapped.message.length).toBeGreaterThan(10);
    expect(mapped.details).toEqual({ hint });
  });

  it('says which roster roles are allowed, so the refusal is actionable', () => {
    const mapped = describeEligibilityFailure(
      refusal('role_cannot_join_team'),
    ) as AppException;
    expect(mapped.message).toContain('players');
    expect(mapped.message).toContain('analysts');
  });

  it('leaves an unrelated failure untouched', () => {
    const conflict = AppException.conflict('This player is already active on another roster.');
    expect(describeEligibilityFailure(conflict)).toBe(conflict);

    const other = refusal('single_team');
    expect(describeEligibilityFailure(other)).toBe(other);

    const plain = new Error('socket hang up');
    expect(describeEligibilityFailure(plain)).toBe(plain);
  });

  it('reads no hint off an error that carries none', () => {
    expect(eligibilityHint(AppException.internal())).toBeNull();
    expect(eligibilityHint(new Error('nope'))).toBeNull();
    expect(
      eligibilityHint(AppException.unprocessable('x', 'UNPROCESSABLE', 'not-an-object')),
    ).toBeNull();
  });
});
