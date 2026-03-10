import { registerAs } from '@nestjs/config';

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default registerAs('finance', () => ({
  baseUrl: process.env.FINANCE_API_URL || '',
  timeoutMs: parseNumber(process.env.FINANCE_API_TIMEOUT_MS, 15000),
}));
