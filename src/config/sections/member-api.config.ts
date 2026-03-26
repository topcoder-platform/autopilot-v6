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
 * Member API outbound configuration used by autopilot challenge completion flows.
 *
 * Environment variables:
 * - `MEMBER_API_URL` (optional): Base URL of member-api-v6, such as `http://member-api:3000`.
 *   When absent, outbound member stats refresh and rerate calls are disabled.
 * - `MEMBER_API_TIMEOUT_MS` (optional, default `15000`): HTTP timeout in milliseconds for member-api calls.
 */
export default registerAs('memberApi', () => ({
  baseUrl: (process.env.MEMBER_API_URL || '').trim(),
  timeoutMs: parseNumber(process.env.MEMBER_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
}));
