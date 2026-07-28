import { registerAs } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Parses a positive integer environment value and falls back when the value is absent or invalid.
 * @param value Raw environment variable value.
 * @param fallback Default value used when parsing fails.
 * @returns Parsed positive integer configuration value.
 * @throws Never. Invalid values are ignored and the fallback is returned.
 */
const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Resolves the member API base URL.
 *
 * BUS_API_URL includes the versioned Bus API path, so only its origin is used
 * when falling back to the public API gateway for member requests.
 */
const resolveBaseUrl = (): string => {
  const memberApiUrl = process.env.MEMBER_API_URL?.trim();
  if (memberApiUrl) {
    return memberApiUrl;
  }

  const busApiUrl = process.env.BUS_API_URL?.trim();
  if (!busApiUrl) {
    return '';
  }

  try {
    return new URL(busApiUrl).origin;
  } catch {
    return busApiUrl;
  }
};

/**
 * Member API outbound configuration used by autopilot challenge completion flows.
 *
 * Environment variables:
 * - `MEMBER_API_URL` (optional): Base URL of member-api-v6, such as `http://member-api:3000`.
 * - `BUS_API_URL` (fallback): Its origin is used as the public API gateway base URL when
 *   `MEMBER_API_URL` is absent.
 *   When both are absent, outbound member stats refresh and rerate calls are disabled.
 * - `MEMBER_API_TIMEOUT_MS` (optional, default `15000`): HTTP timeout in milliseconds for member-api calls.
 */
export default registerAs('memberApi', () => ({
  baseUrl: resolveBaseUrl(),
  timeoutMs: parseNumber(process.env.MEMBER_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
}));
