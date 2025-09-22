import { registerAs } from '@nestjs/config';

export default registerAs('challenge', () => ({
  dbUrl: process.env.CHALLENGE_DB_URL,
}));
