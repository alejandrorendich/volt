/**
 * @fileoverview Tests for the pure helpers in {@link update-service}.
 *
 * These cover the two pieces of logic that have historically caused silent
 * auto-update failures: parsing the GitHub Releases API payload and
 * comparing semver strings.
 */

import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseReleaseInfo } from './release-utils';

describe('parseReleaseInfo', () => {
  const validAsset = {
    name: 'volt-0.8.3.vsix',
    browser_download_url:
      'https://github.com/alejandrorendich/volt/releases/download/v0.8.3/volt-0.8.3.vsix',
  };

  it('returns version + vsixUrl for a well-formed release payload', () => {
    const result = parseReleaseInfo({
      tag_name: 'v0.8.3',
      assets: [validAsset],
    });

    expect(result).toEqual({
      version: '0.8.3',
      vsixUrl: validAsset.browser_download_url,
    });
  });

  it('strips the leading "v" from tag_name', () => {
    const result = parseReleaseInfo({
      tag_name: 'v1.2.3',
      assets: [validAsset],
    });
    expect(result?.version).toBe('1.2.3');
  });

  it('accepts tag_name without the "v" prefix', () => {
    const result = parseReleaseInfo({
      tag_name: '1.2.3',
      assets: [validAsset],
    });
    expect(result?.version).toBe('1.2.3');
  });

  it('picks the .vsix asset when other assets are present', () => {
    const result = parseReleaseInfo({
      tag_name: 'v0.8.3',
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://example/ignore' },
        validAsset,
        { name: 'source.zip', browser_download_url: 'https://example/ignore' },
      ],
    });
    expect(result?.vsixUrl).toBe(validAsset.browser_download_url);
  });

  it('returns null when the .vsix asset is missing', () => {
    const result = parseReleaseInfo({
      tag_name: 'v0.8.3',
      assets: [{ name: 'checksums.txt', browser_download_url: 'https://x' }],
    });
    expect(result).toBeNull();
  });

  it('returns null when assets is empty', () => {
    const result = parseReleaseInfo({ tag_name: 'v0.8.3', assets: [] });
    expect(result).toBeNull();
  });

  it('returns null when assets is not an array', () => {
    const result = parseReleaseInfo({ tag_name: 'v0.8.3', assets: 'oops' });
    expect(result).toBeNull();
  });

  it('returns null when tag_name is missing', () => {
    const result = parseReleaseInfo({ assets: [validAsset] });
    expect(result).toBeNull();
  });

  it('returns null when tag_name is not a string', () => {
    const result = parseReleaseInfo({ tag_name: 83, assets: [validAsset] });
    expect(result).toBeNull();
  });

  it('returns null when browser_download_url is missing on the .vsix asset', () => {
    const result = parseReleaseInfo({
      tag_name: 'v0.8.3',
      assets: [{ name: 'volt-0.8.3.vsix' }],
    });
    expect(result).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseReleaseInfo(null)).toBeNull();
    expect(parseReleaseInfo('string')).toBeNull();
    expect(parseReleaseInfo(42)).toBeNull();
    expect(parseReleaseInfo(undefined)).toBeNull();
    expect(parseReleaseInfo([])).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('returns true when patch is higher', () => {
    expect(isNewerVersion('0.8.3', '0.8.2')).toBe(true);
  });

  it('returns false when patch is lower', () => {
    expect(isNewerVersion('0.8.2', '0.8.3')).toBe(false);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('0.8.3', '0.8.3')).toBe(false);
  });

  it('returns true when minor is higher even if patch is lower', () => {
    expect(isNewerVersion('0.9.0', '0.8.99')).toBe(true);
  });

  it('returns true when major is higher', () => {
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('strips the "v" prefix on either side', () => {
    expect(isNewerVersion('v0.8.3', '0.8.2')).toBe(true);
    expect(isNewerVersion('0.8.3', 'v0.8.2')).toBe(true);
    expect(isNewerVersion('v0.8.3', 'v0.8.2')).toBe(true);
  });

  it('treats missing parts as 0', () => {
    expect(isNewerVersion('0.8', '0.8.0')).toBe(false);
    expect(isNewerVersion('0.9', '0.8.99')).toBe(true);
    expect(isNewerVersion('1', '0.99.99')).toBe(true);
  });

  it('returns false for non-numeric parts instead of throwing', () => {
    expect(isNewerVersion('garbage', '0.8.3')).toBe(false);
    expect(isNewerVersion('0.8.3', 'garbage')).toBe(false);
    expect(isNewerVersion('0.8.beta', '0.8.3')).toBe(false);
  });

  it('returns false when remote or current is empty', () => {
    expect(isNewerVersion('', '0.8.3')).toBe(false);
    expect(isNewerVersion('0.8.3', '')).toBe(false);
  });
});
