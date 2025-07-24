import { registerAs } from '@nestjs/config';

export default registerAs('challenge', () => ({
  apiUrl: process.env.CHALLENGE_API_URL,
  m2mToken: process.env.CHALLENGE_API_M2M_TOKEN,
  // New: Configurable retry settings for the Challenge API client
  retry: {
    attempts: parseInt(process.env.CHALLENGE_API_RETRY_ATTEMPTS ?? '3', 10),
    initialDelay: parseInt(process.env.CHALLENGE_API_RETRY_DELAY ?? '1000', 10),
  },
}));
