import { registerAs } from '@nestjs/config';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default registerAs('review', () => {
  const pollIntervalEnv = process.env.REVIEWER_POLL_INTERVAL_MS;
  const pollInterval = Number(pollIntervalEnv);

  return {
    dbUrl: process.env.REVIEW_DB_URL,
    assignmentPollIntervalMs:
      Number.isFinite(pollInterval) && pollInterval > 0
        ? pollInterval
        : DEFAULT_POLL_INTERVAL_MS,
    summationApiUrl: (process.env.REVIEW_SUMMATION_API_URL || '').trim(),
    summationApiTimeoutMs: parseNumber(
      process.env.REVIEW_SUMMATION_API_TIMEOUT_MS,
      15000,
    ),
  };
});
