import { registerAs } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 15000;

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Marathon Match outbound API configuration used by autopilot review orchestration.
 */
export default registerAs('marathonMatch', () => ({
  baseUrl: (process.env.MARATHON_MATCH_API_URL || '').trim(),
  timeoutMs: parseNumber(
    process.env.MARATHON_MATCH_API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  ),
  systemResourceId:
    (process.env.MARATHON_MATCH_SYSTEM_RESOURCE_ID || '').trim() || null,
}));
