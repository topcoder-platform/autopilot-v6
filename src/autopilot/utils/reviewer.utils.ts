import { IChallengeReviewer } from '../../challenge/interfaces/challenge.interface';

export function getMemberReviewerConfigs(
  reviewers: IChallengeReviewer[] | undefined,
  phaseTemplateId: string,
): IChallengeReviewer[] {
  if (!reviewers?.length) {
    return [];
  }

  return reviewers.filter(
    (reviewer) =>
      reviewer.isMemberReview && reviewer.phaseId === phaseTemplateId,
  );
}

// For screening phases (including Checkpoint Screening), reviewer configs may not be flagged as member reviews.
// This helper returns all reviewer configs for the given phase template regardless of isMemberReview.
export function getReviewerConfigsForPhase(
  reviewers: IChallengeReviewer[] | undefined,
  phaseTemplateId: string,
): IChallengeReviewer[] {
  if (!reviewers?.length) {
    return [];
  }

  return reviewers.filter((reviewer) => reviewer.phaseId === phaseTemplateId);
}

export function getRequiredReviewerCountForPhase(
  reviewers: IChallengeReviewer[] | undefined,
  phaseTemplateId: string,
): number {
  const configs = getMemberReviewerConfigs(reviewers, phaseTemplateId);

  if (!configs.length) {
    return 0;
  }

  return configs.reduce((total, config) => {
    const count = config.memberReviewerCount ?? 1;
    return total + Math.max(count, 0);
  }, 0);
}

export function selectScorecardId(
  reviewers: IChallengeReviewer[],
  onMissing?: () => void | null,
  onMultiple?: (choices: Array<string | null | undefined>) => void | null,
  phaseTemplateId?: string,
): string | null {
  const configs = phaseTemplateId
    ? getMemberReviewerConfigs(reviewers, phaseTemplateId)
    : reviewers.filter((reviewer) => reviewer.isMemberReview);

  const uniqueScorecards = Array.from(
    new Set(configs.map((config) => config.scorecardId).filter(Boolean)),
  );

  if (uniqueScorecards.length === 0) {
    onMissing?.();
    return null;
  }

  if (uniqueScorecards.length > 1) {
    onMultiple?.(uniqueScorecards);
  }

  return uniqueScorecards[0] ?? null;
}
