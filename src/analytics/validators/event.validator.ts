import { isUuid } from '../../common/utils/uuid';
import {
  ANALYTICS_ENTITY_TYPES,
  ANALYTICS_PLATFORMS,
  EVENT_ENTITY_RULES,
  ANALYTICS_EVENT_NAMES,
  allowsAnyEntityType,
  type AnalyticsEventName,
} from '../analytics.types';
import type { AnalyticsEventDto } from '../dto/analytics.dto';

/**
 * Event validation (plan §7 and §12). The taxonomy is code, not convention:
 * an event that does not clear every rule here is refused with
 * `INVALID_ANALYTICS_EVENT` — never coerced, never silently accepted.
 */

/** Property values must be flat primitives — no nested objects, no arrays. */
const MAX_PROPERTY_KEYS = 24;
const MAX_KEY_LENGTH = 40;
const MAX_STRING_VALUE = 200;
const MAX_PROPERTIES_JSON = 4096; // characters of serialised JSON

/**
 * Keys that must never arrive in `properties` (plan §9: no passwords, tokens,
 * emails or credentials — not even by accident from a careless call site).
 */
const SENSITIVE_KEY = /pass(word)?|token|secret|email|auth|cookie|credential|api[_-]?key/i;

/** One validation failure, phrased so the client developer can fix the call. */
export type EventValidationIssue = { index: number; message: string };

/**
 * Validates one event and returns a sentence describing the first rule it
 * breaks, or null when the event is acceptable. `index` is the event's
 * position in the batch, carried into the error `details`.
 */
export function validateAnalyticsEvent(event: AnalyticsEventDto, index: number): EventValidationIssue | null {
  const fail = (message: string): EventValidationIssue => ({ index, message });

  if (!(ANALYTICS_EVENT_NAMES as readonly string[]).includes(event.name)) {
    return fail(`unknown analytics event '${event.name}'`);
  }
  const name = event.name as AnalyticsEventName;

  // Platform is optional (older clients), but a supplied one must be real.
  if (event.platform !== undefined && !(ANALYTICS_PLATFORMS as readonly string[]).includes(event.platform)) {
    return fail(`platform '${event.platform}' is not one of: ${ANALYTICS_PLATFORMS.join(', ')}`);
  }

  const rule = EVENT_ENTITY_RULES[name];
  const hasEntityType = event.entity_type !== undefined && event.entity_type !== null;
  const hasEntityId = event.entity_id !== undefined && event.entity_id !== null;

  if (rule === null) {
    if (hasEntityType || hasEntityId) {
      return fail(`'${name}' is a session-level event and must not carry an entity`);
    }
  } else if (!hasEntityType && rule.required) {
    return fail(`'${name}' requires entity_type '${rule.type}'`);
  } else if (hasEntityType) {
    if (!allowsAnyEntityType(name) && event.entity_type !== rule.type) {
      return fail(`'${name}' requires entity_type '${rule.type}', got '${event.entity_type}'`);
    }
    if (!(ANALYTICS_ENTITY_TYPES as readonly string[]).includes(event.entity_type as string)) {
      return fail(`entity_type '${event.entity_type}' is not one of: ${ANALYTICS_ENTITY_TYPES.join(', ')}`);
    }
    if (!hasEntityId) {
      return fail(`'${name}' requires entity_id`);
    }
  }

  if (hasEntityId && !isUuid(String(event.entity_id))) {
    return fail('entity_id must be a uuid');
  }
  if (event.event_id !== undefined && event.event_id !== null && !isUuid(event.event_id)) {
    return fail('event_id must be a uuid');
  }

  return validateProperties(event.properties, index);
}

/**
 * Properties must be a small, flat map of primitives. Anything bigger,
 * deeper, or smelling like a credential is refused — the raw ledger is
 * forever, so nothing ambiguous gets to enter it.
 */
function validateProperties(
  properties: Record<string, unknown> | undefined,
  index: number,
): EventValidationIssue | null {
  if (properties === undefined || properties === null) return null;

  const keys = Object.keys(properties);
  if (keys.length > MAX_PROPERTY_KEYS) {
    return { index, message: `properties may hold at most ${MAX_PROPERTY_KEYS} keys` };
  }

  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      return { index, message: `property key '${key.slice(0, 20)}…' must be 1–${MAX_KEY_LENGTH} characters` };
    }
    if (SENSITIVE_KEY.test(key)) {
      return { index, message: `property key '${key}' may not hold credential-like data` };
    }
    const value = properties[key];
    if (value === null) continue;
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_VALUE) {
        return { index, message: `property '${key}' exceeds ${MAX_STRING_VALUE} characters` };
      }
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return { index, message: `property '${key}' must be a finite number` };
      }
      continue;
    }
    if (typeof value === 'boolean') continue;
    return { index, message: `property '${key}' must be a string, number, boolean or null — no nested objects` };
  }

  if (JSON.stringify(properties).length > MAX_PROPERTIES_JSON) {
    return { index, message: `serialised properties exceed ${MAX_PROPERTIES_JSON} characters` };
  }
  return null;
}
