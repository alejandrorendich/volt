/**
 * @fileoverview AWS Signature Version 4 signing utility.
 *
 * Computes the SigV4 Authorization header and supplementary headers
 * (X-Amz-Date, X-Amz-Security-Token) required to authenticate requests
 * against AWS services.
 *
 * Algorithm reference:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * Implementation uses Node's built-in `crypto` module — no third-party deps.
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignRequestParams {
  readonly method: string;
  readonly url: string;
  /** Headers that will be sent with the request (already interpolated). */
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * Sign an HTTP request with AWS Signature Version 4.
 *
 * Returns the additional headers that must be merged into the request:
 *   - `Authorization`
 *   - `X-Amz-Date`
 *   - `X-Amz-Security-Token` (only when `sessionToken` is provided)
 *
 * The caller is responsible for ensuring that environment variable
 * interpolation has already been applied to url/headers/body before calling
 * this function — SigV4 signs the actual payload, not the template.
 */
export function signRequest(params: SignRequestParams): Record<string, string> {
  const parsedUrl = new URL(params.url);

  // --- 1. Amz date/time strings ---
  const now = new Date();
  const amzDate = formatAmzDate(now);          // e.g. "20240601T120000Z"
  const dateStamp = amzDate.slice(0, 8);       // e.g. "20240601"

  // --- 2. Canonical URI ---
  const canonicalUri = encodeCanonicalUri(parsedUrl.pathname);

  // --- 3. Canonical query string (alphabetically sorted) ---
  const canonicalQueryString = buildCanonicalQueryString(parsedUrl.searchParams);

  // --- 4. Signed headers ---
  // Always include host; always include x-amz-date; optionally x-amz-security-token
  const signingHeaders: Record<string, string> = {
    host: parsedUrl.host,
    'x-amz-date': amzDate,
  };
  if (params.sessionToken) {
    signingHeaders['x-amz-security-token'] = params.sessionToken;
  }

  // Merge any caller-supplied headers we also want to sign (lower-cased)
  for (const [k, v] of Object.entries(params.headers)) {
    const lk = k.toLowerCase();
    // Skip host/date — already set above
    if (lk !== 'host' && lk !== 'x-amz-date' && lk !== 'x-amz-security-token') {
      signingHeaders[lk] = v;
    }
  }

  // Sort header names for the canonical form
  const sortedHeaderNames = Object.keys(signingHeaders).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${trimHeaderValue(signingHeaders[name] ?? '')}\n`)
    .join('');
  const signedHeaders = sortedHeaderNames.join(';');

  // --- 5. Payload hash ---
  const payloadHash = sha256Hex(params.body);

  // --- 6. Canonical request ---
  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // --- 7. String to sign ---
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // --- 8. Signing key (HMAC chain) ---
  const signingKey = deriveSigningKey(
    params.secretAccessKey,
    dateStamp,
    params.region,
    params.service,
  );

  // --- 9. Signature ---
  const signature = hmacSha256Hex(signingKey, stringToSign);

  // --- 10. Authorization header ---
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const result: Record<string, string> = {
    Authorization: authorization,
    'X-Amz-Date': amzDate,
  };

  if (params.sessionToken) {
    result['X-Amz-Security-Token'] = params.sessionToken;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format a Date as "YYYYMMDDTHHmmssZ" (no dashes/colons). */
function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/**
 * URI-encode each path segment individually.
 * RFC 3986 unreserved characters are NOT encoded.
 */
function encodeCanonicalUri(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

/** Build a sorted, percent-encoded query string for canonical form. */
function buildCanonicalQueryString(params: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    entries.push([encodeRfc3986(key), encodeRfc3986(value)]);
  });
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Encode a string per RFC 3986 (encodes everything except unreserved chars). */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/** Trim leading/trailing whitespace and collapse inner whitespace runs. */
function trimHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** SHA-256 hash of a UTF-8 string, returned as lowercase hex. */
function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/** HMAC-SHA256 of `data` using `key` (Buffer), returned as lowercase hex. */
function hmacSha256Hex(key: Buffer, data: string): string {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** HMAC-SHA256 of `data` using `key` (Buffer), returned as Buffer. */
function hmacSha256(key: Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Derive the SigV4 signing key via the HMAC chain:
 *   HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")
 */
function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate    = hmacSha256(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}
