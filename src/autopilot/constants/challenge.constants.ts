export const FIRST2FINISH_TYPE = 'first2finish';
export const TOPGEAR_TASK_TYPE = 'topgear task';
export const MARATHON_MATCH_TYPE = 'marathon match';

export function normalizeChallengeType(type?: string): string {
  return (type ?? '').toLowerCase();
}

export function isTopgearTaskChallenge(type?: string): boolean {
  return normalizeChallengeType(type) === TOPGEAR_TASK_TYPE;
}

/**
 * Identifies Marathon Match challenges using the normalized challenge type.
 */
export function isMarathonMatchChallenge(type?: string): boolean {
  return normalizeChallengeType(type) === MARATHON_MATCH_TYPE;
}

export function isFirst2FinishChallenge(type?: string): boolean {
  const normalized = normalizeChallengeType(type);
  return normalized === FIRST2FINISH_TYPE || normalized === TOPGEAR_TASK_TYPE;
}

export function describeChallengeType(type?: string): string {
  const normalized = normalizeChallengeType(type);
  if (normalized === TOPGEAR_TASK_TYPE) {
    return 'Topgear Task';
  }
  if (normalized === FIRST2FINISH_TYPE) {
    return 'First2Finish';
  }
  return type ?? 'Unknown';
}
