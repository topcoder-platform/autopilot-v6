import { registerAs } from '@nestjs/config';

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export default registerAs('review', () => {
  const pollIntervalEnv = process.env.REVIEWER_POLL_INTERVAL_MS;
  const pollInterval = Number(pollIntervalEnv);

  return {
    dbUrl: process.env.REVIEW_DB_URL,
    assignmentPollIntervalMs:
      Number.isFinite(pollInterval) && pollInterval > 0
        ? pollInterval
        : DEFAULT_POLL_INTERVAL_MS,
  };
});
