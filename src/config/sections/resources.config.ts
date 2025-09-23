import { registerAs } from '@nestjs/config';

export default registerAs('resources', () => ({
  dbUrl: process.env.RESOURCES_DB_URL,
}));
