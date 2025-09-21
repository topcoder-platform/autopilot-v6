import { registerAs } from '@nestjs/config';

export default registerAs('challenge', () => ({
  apiUrl: process.env.CHALLENGE_API_URL,
  retry: {
    attempts: parseInt(
      process.env.CHALLENGE_API_RETRIES ??
        process.env.CHALLENGE_API_RETRY_ATTEMPTS ??
        '3',
      10,
    ),
    initialDelay: parseInt(process.env.CHALLENGE_API_RETRY_DELAY ?? '1000', 10),
  },
}));
