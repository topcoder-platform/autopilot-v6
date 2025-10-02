import { registerAs } from '@nestjs/config';

export default registerAs('members', () => ({
  dbUrl: process.env.MEMBERS_DB_URL,
}));
