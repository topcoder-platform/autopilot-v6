export const FIRST2FINISH_TYPE = 'first2finish';
export const TOPGEAR_TASK_TYPE = 'topgear task';

export function normalizeChallengeType(type?: string): string {
  return (type ?? '').toLowerCase();
}

export function isTopgearTaskChallenge(type?: string): boolean {
  return normalizeChallengeType(type) === TOPGEAR_TASK_TYPE;
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
