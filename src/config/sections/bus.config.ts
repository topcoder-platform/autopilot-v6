import { registerAs } from '@nestjs/config';

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default registerAs('bus', () => ({
  url: process.env.BUS_API_URL,
  timeoutMs: parseNumber(process.env.BUS_API_TIMEOUT_MS, 10000),
  originator: process.env.BUS_API_ORIGINATOR || 'autopilot-service',
}));
