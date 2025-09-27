import { registerAs } from '@nestjs/config';

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default registerAs('autopilot', () => ({
  dbUrl: process.env.AUTOPILOT_DB_URL,
  dbDebug: process.env.DB_DEBUG === 'true',
  postMortemScorecardId: process.env.POST_MORTEM_SCORECARD_ID || null,
  postMortemDurationHours: parseNumber(
    process.env.POST_MORTEM_DURATION_HOURS,
    72,
  ),
  postMortemRoles: parseList(process.env.POST_MORTEM_REVIEW_ROLES, [
    'Reviewer',
    'Copilot',
  ]),
  submitterRoles: parseList(process.env.SUBMITTER_ROLE_NAMES, ['Submitter']),
  iterativeReviewDurationHours: parseNumber(
    process.env.ITERATIVE_REVIEW_DURATION_HOURS,
    24,
  ),
  appealsPhaseNames: parseList(process.env.APPEALS_PHASE_NAMES, ['Appeals']),
  appealsResponsePhaseNames: parseList(
    process.env.APPEALS_RESPONSE_PHASE_NAMES,
    ['Appeals Response'],
  ),
}));
