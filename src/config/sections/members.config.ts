import { registerAs } from '@nestjs/config';

export default registerAs('members', () => ({
  dbUrl: process.env.MEMBER_DB_URL,
}));
