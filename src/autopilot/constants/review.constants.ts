export const REVIEW_PHASE_NAMES = new Set([
  'Review',
  'Iterative Review',
  'Post-Mortem',
]);

export const ITERATIVE_REVIEW_PHASE_NAME = 'Iterative Review';
export const POST_MORTEM_PHASE_NAME = 'Post-Mortem';
export const REGISTRATION_PHASE_NAME = 'Registration';
export const SUBMISSION_PHASE_NAME = 'Submission';

export const DEFAULT_APPEALS_PHASE_NAMES = new Set(['Appeals']);
export const DEFAULT_APPEALS_RESPONSE_PHASE_NAMES = new Set([
  'Appeals Response',
]);

const DEFAULT_PHASE_ROLES = ['Reviewer', 'Iterative Reviewer'];

export const PHASE_ROLE_MAP: Record<string, string[]> = {
  Review: ['Reviewer'],
  'Iterative Review': ['Iterative Reviewer'],
  'Post-Mortem': ['Reviewer', 'Copilot'],
};

export function getRoleNamesForPhase(phaseName: string): string[] {
  return PHASE_ROLE_MAP[phaseName] ?? DEFAULT_PHASE_ROLES;
}
