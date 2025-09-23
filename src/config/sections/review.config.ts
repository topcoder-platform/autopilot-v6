import { registerAs } from '@nestjs/config';

export default registerAs('review', () => ({
  dbUrl: process.env.REVIEW_DB_URL,
}));
