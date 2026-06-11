/**
 * @fileoverview Assertion evaluator for GUI-based test rules.
 *
 * Evaluates a list of `AssertionRule` objects against an HTTP response and
 * produces `AssertionResult` outcomes. Supports `{{variable}}` interpolation
 * in the expected value via the provided variable map.
 *
 * Supported subjects:
 *   - `status`   — response HTTP status code
 *   - `time`     — total response time in milliseconds
 *   - `jsonpath` — dot-notation path into the response JSON body
 *   - `header`   — response header value by name
 *
 * Supported operators:
 *   - `eq`       — strict equality (string comparison after normalisation)
 *   - `neq`      — not equal
 *   - `contains` — actual value contains expected substring
 *   - `gt`       — actual > expected (numeric)
 *   - `lt`       — actual < expected (numeric)
 *   - `exists`   — actual value is non-null / non-undefined / non-empty
 */

import type { AssertionRule, AssertionResult, HttpResponseDef } from '../../shared/models';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate all assertion rules against the given HTTP response.
 *
 * @param rules     - Assertion rules from the request definition.
 * @param response  - The HTTP response to evaluate against.
 * @param variables - Resolved environment variables for `{{var}}` interpolation.
 * @returns         - An array of results, one per rule.
 */
export function evaluateAssertions(
  rules: readonly AssertionRule[],
  response: HttpResponseDef,
  variables: Record<string, string>,
): AssertionResult[] {
  return rules.map((rule) => evaluateOne(rule, response, variables));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function evaluateOne(
  rule: AssertionRule,
  response: HttpResponseDef,
  variables: Record<string, string>,
): AssertionResult {
  const expected = interpolate(rule.expected, variables);
  const actual = extractActual(rule, response);

  if (actual === null) {
    // Property not found — only `exists` can pass when value is absent
    const pass = rule.operator === 'exists' ? false : false;
    return { id: rule.id, pass, actual: '(not found)' };
  }

  const pass = compare(rule.operator, actual, expected);
  return { id: rule.id, pass, actual };
}

/**
 * Extract the actual string value from the response based on the rule subject.
 * Returns `null` when the property cannot be found.
 */
function extractActual(rule: AssertionRule, response: HttpResponseDef): string | null {
  switch (rule.subject) {
    case 'status':
      return String(response.status);

    case 'time':
      return String(response.timing.total);

    case 'header': {
      const headerName = rule.property.toLowerCase();
      // Header lookup is case-insensitive
      for (const [k, v] of Object.entries(response.headers)) {
        if (k.toLowerCase() === headerName) return v;
      }
      return null;
    }

    case 'jsonpath': {
      if (!rule.property) return null;
      try {
        const parsed: unknown = JSON.parse(response.body);
        const value = extractJsonPath(parsed, rule.property);
        if (value === undefined || value === null) return null;
        return typeof value === 'string' ? value : JSON.stringify(value);
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Extract a value from a parsed JSON object using dot-notation path.
 * Supports array index notation: `data[0].name`.
 *
 * Examples:
 *   `user.id`        → obj.user.id
 *   `data[0].name`   → obj.data[0].name
 *   `items[1].value` → obj.items[1].value
 */
function extractJsonPath(obj: unknown, path: string): unknown {
  // Normalise array access: "data[0]" → "data.0"
  const normalised = path.replace(/\[(\d+)\]/g, '.$1');
  const segments = normalised.split('.').filter(Boolean);

  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Compare actual vs expected values using the given operator.
 */
function compare(operator: AssertionRule['operator'], actual: string, expected: string): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;

    case 'neq':
      return actual !== expected;

    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());

    case 'gt': {
      const a = parseFloat(actual);
      const e = parseFloat(expected);
      if (isNaN(a) || isNaN(e)) return false;
      return a > e;
    }

    case 'lt': {
      const a = parseFloat(actual);
      const e = parseFloat(expected);
      if (isNaN(a) || isNaN(e)) return false;
      return a < e;
    }

    case 'exists':
      return actual !== '' && actual !== 'null' && actual !== 'undefined';

    default:
      return false;
  }
}

/**
 * Interpolate `{{variable}}` placeholders in a string using the variable map.
 */
function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string): string => {
    const trimmed = key.trim();
    return trimmed in variables ? (variables[trimmed] ?? match) : `{{${trimmed}}}`;
  });
}
