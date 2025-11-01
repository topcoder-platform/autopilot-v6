export const ITERATIVE_REVIEW_PHASE_NAME = 'Iterative Review';
export const POST_MORTEM_PHASE_NAME = 'Post-Mortem';
export const POST_MORTEM_PHASE_ALTERNATE_NAME = 'Post-mortem';
export const POST_MORTEM_PHASE_NAMES = new Set<string>([
  POST_MORTEM_PHASE_NAME,
  POST_MORTEM_PHASE_ALTERNATE_NAME,
]);
export const REVIEW_PHASE_NAMES = new Set<string>([
  'Review',
  'Iterative Review',
  ...POST_MORTEM_PHASE_NAMES,
  'Checkpoint Review',
]);
export const POST_MORTEM_REVIEWER_ROLE_NAME = 'Post-Mortem Reviewer';
export const REGISTRATION_PHASE_NAME = 'Registration';
export const SUBMISSION_PHASE_NAME = 'Submission';
export const TOPGEAR_SUBMISSION_PHASE_NAME = 'Topgear Submission';
export const CHECKPOINT_SUBMISSION_PHASE_NAME = 'Checkpoint Submission';

export const SUBMISSION_PHASE_NAMES = new Set<string>([
  SUBMISSION_PHASE_NAME,
  TOPGEAR_SUBMISSION_PHASE_NAME,
  CHECKPOINT_SUBMISSION_PHASE_NAME,
]);

export const DEFAULT_APPEALS_PHASE_NAMES = new Set(['Appeals']);
export const DEFAULT_APPEALS_RESPONSE_PHASE_NAMES = new Set([
  'Appeals Response',
]);

// Screening phases that require all scorecards to be submitted before closing
export const SCREENING_PHASE_NAMES = new Set<string>([
  'Screening',
  'Checkpoint Screening',
]);

// Approval phases that require all scorecards to be submitted before closing
export const APPROVAL_PHASE_NAMES = new Set<string>(['Approval']);

const DEFAULT_PHASE_ROLES = ['Reviewer', 'Iterative Reviewer'];

export const PHASE_ROLE_MAP: Record<string, string[]> = {
  Review: ['Reviewer'],
  'Iterative Review': ['Iterative Reviewer'],
  'Post-Mortem': [POST_MORTEM_REVIEWER_ROLE_NAME],
  'Post-mortem': [POST_MORTEM_REVIEWER_ROLE_NAME],
  'Checkpoint Review': ['Checkpoint Reviewer'],
  Screening: ['Screener'],
  // Use the specific Checkpoint Screener role for checkpoint screening phases
  'Checkpoint Screening': ['Checkpoint Screener'],
  Approval: ['Approver'],
};

export function getRoleNamesForPhase(phaseName: string): string[] {
  return PHASE_ROLE_MAP[phaseName] ?? DEFAULT_PHASE_ROLES;
}

export function isPostMortemPhaseName(phaseName: string): boolean {
  return POST_MORTEM_PHASE_NAMES.has(phaseName);
}

export function isSubmissionPhaseName(phaseName: string): boolean {
  return SUBMISSION_PHASE_NAMES.has(phaseName);
}
