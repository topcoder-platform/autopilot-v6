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
