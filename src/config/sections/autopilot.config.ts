import { registerAs } from '@nestjs/config';

export default registerAs('autopilot', () => ({
  dbUrl: process.env.AUTOPILOT_DB_URL,
  dbDebug: process.env.DB_DEBUG === 'true',
}));
