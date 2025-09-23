export const REVIEW_PHASE_NAMES = new Set(['Review', 'Iterative Review']);

const DEFAULT_PHASE_ROLES = ['Reviewer', 'Iterative Reviewer'];

export const PHASE_ROLE_MAP: Record<string, string[]> = {
  Review: ['Reviewer'],
  'Iterative Review': ['Iterative Reviewer'],
};

export function getRoleNamesForPhase(phaseName: string): string[] {
  return PHASE_ROLE_MAP[phaseName] ?? DEFAULT_PHASE_ROLES;
}
