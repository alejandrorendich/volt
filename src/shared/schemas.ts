/**
 * @fileoverview Volt - ajv JSON Schemas for YAML validation.
 *
 * Provides compiled validators for:
 * - Request YAML files (.volt/requests/**\/*.yaml)
 * - Environment YAML files (.volt/envs/*.yaml)
 *
 * Usage:
 *
 *   import { validateRequestDef, validateEnvironmentDef } from 'shared/schemas';
 *   const result = validateRequestDef(parsed);
 *   if (!result.valid) console.error(result.errors);
 *
 * @see REQ-COL-003 - YAML schema validation on load
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// Ajv instance
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
// Register standard format validators (date-time, uri, email, etc.).
// AJV 8 split these out of core; without this, `format: 'date-time'` is
// silently ignored and emits an `unknown format` warning at compile time.
addFormats(ajv);

// ---------------------------------------------------------------------------
// Request YAML schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for a Volt request YAML file.
 * Mirrors `HttpRequestDef` in `src/shared/models.ts`.
 */
const requestYamlSchema = {
  type: 'object',
  required: ['method', 'url'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    notes: {
      type: 'string',
      description: 'Optional human-readable notes for this request. Supports Markdown (GFM).',
    },
    notesUpdatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp of the last notes edit',
    },
    method: {
      type: 'string',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    },
    url: { type: 'string' },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    body: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['json', 'text', 'form-data', 'none', 'binary', 'graphql'],
        },
        content: { type: 'string' },
        filePath: { type: 'string' },
        query: { type: 'string' },
        variables: { type: 'string' },
        operationName: { type: 'string' },
      },
      if: { properties: { type: { enum: ['json', 'text', 'form-data'] } } },
      then: { required: ['content'] },
    },
    queryParams: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'value', 'enabled'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    preScript: { type: 'string' },
    postScript: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Environment YAML schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for a Volt environment YAML file.
 *
 * Supports two formats:
 * 1. Flat key-value: `{ baseUrl: "http://localhost:3000" }`
 * 2. Structured: `{ name: "dev", variables: { baseUrl: "..." } }`
 *
 * Both are valid; the loader handles both.
 */
const environmentYamlSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string' },
    variables: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
        ],
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Compiled validators
// ---------------------------------------------------------------------------

const _validateRequest = ajv.compile(requestYamlSchema);
const _validateEnvironment = ajv.compile(environmentYamlSchema);

// ---------------------------------------------------------------------------
// Validation result type
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed request YAML object.
 * Returns `{ valid: true }` on success, or `{ valid: false, errors }` with
 * human-readable error messages on failure.
 */
export function validateRequestDef(data: unknown): ValidationResult {
  const valid = _validateRequest(data);
  if (valid) return { valid: true, errors: [] };

  const errors = (_validateRequest.errors ?? []).map((e) => {
    const field = e.instancePath ? `Field "${e.instancePath}": ` : '';
    return `${field}${e.message ?? 'validation error'}`;
  });

  return { valid: false, errors };
}

/**
 * Validate a parsed environment YAML object.
 * Returns `{ valid: true }` on success, or `{ valid: false, errors }`.
 */
export function validateEnvironmentDef(data: unknown): ValidationResult {
  const valid = _validateEnvironment(data);
  if (valid) return { valid: true, errors: [] };

  const errors = (_validateEnvironment.errors ?? []).map((e) => {
    const field = e.instancePath ? `Field "${e.instancePath}": ` : '';
    return `${field}${e.message ?? 'validation error'}`;
  });

  return { valid: false, errors };
}
