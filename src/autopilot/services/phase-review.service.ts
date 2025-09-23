import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { IChallengeReviewer } from '../../challenge/interfaces/challenge.interface';

const REVIEW_PHASE_NAMES = new Set(['Review', 'Iterative Review']);
const PHASE_ROLE_MAP: Record<string, string[]> = {
  Review: ['Reviewer'],
  'Iterative Review': ['Iterative Reviewer'],
};

@Injectable()
export class PhaseReviewService {
  private readonly logger = new Logger(PhaseReviewService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
  ) {}

  async handlePhaseOpened(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    const challenge = await this.challengeApiService.getChallengeById(challengeId);
    const phase = challenge.phases.find((p) => p.id === phaseId);

    if (!phase) {
      this.logger.warn(
        `Unable to locate phase ${phaseId} for challenge ${challengeId} when creating pending reviews`,
      );
      return;
    }

    if (!REVIEW_PHASE_NAMES.has(phase.name)) {
      return;
    }

    const reviewerConfigs = this.getReviewerConfigsForPhase(
      challenge.reviewers,
      phase.phaseId,
    );

    if (!reviewerConfigs.length) {
      this.logger.log(
        `No member review configurations found for phase ${phase.name} (${phase.id}) on challenge ${challengeId}; skipping review creation`,
      );
      return;
    }

    const scorecardId = this.pickScorecardId(reviewerConfigs, challengeId, phase.id);
    if (!scorecardId) {
      return;
    }

    const roleNames = PHASE_ROLE_MAP[phase.name] ?? ['Reviewer', 'Iterative Reviewer'];
    const reviewerResources = await this.resourcesService.getReviewerResources(
      challengeId,
      roleNames,
    );

    if (!reviewerResources.length) {
      this.logger.log(
        `No reviewer resources found for challenge ${challengeId} and phase ${phase.name}`,
      );
      return;
    }

    const submissionIds = await this.reviewService.getActiveSubmissionIds(challengeId);
    if (!submissionIds.length) {
      this.logger.log(
        `No submissions found for challenge ${challengeId}; skipping review creation for phase ${phase.name}`,
      );
      return;
    }

    const existingPairs = await this.reviewService.getExistingReviewPairs(phase.id);

    let createdCount = 0;
    for (const resource of reviewerResources) {
      for (const submissionId of submissionIds) {
        const key = `${resource.id}:${submissionId}`;
        if (existingPairs.has(key)) {
          continue;
        }

        try {
          await this.reviewService.createPendingReview(
            submissionId,
            resource.id,
            phase.id,
            scorecardId,
          );
          existingPairs.add(key);
          createdCount++;
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to create pending review for challenge ${challengeId}, phase ${phase.id}, submission ${submissionId}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }
    }

    if (createdCount > 0) {
      this.logger.log(
        `Created ${createdCount} pending review(s) for challenge ${challengeId}, phase ${phase.id}`,
      );
    }
  }

  private getReviewerConfigsForPhase(
    reviewers: IChallengeReviewer[],
    phaseTemplateId: string,
  ): IChallengeReviewer[] {
    return reviewers.filter(
      (reviewer) =>
        reviewer.isMemberReview &&
        reviewer.phaseId === phaseTemplateId &&
        Boolean(reviewer.scorecardId),
    );
  }

  private pickScorecardId(
    reviewerConfigs: IChallengeReviewer[],
    challengeId: string,
    phaseId: string,
  ): string | null {
    const uniqueScorecards = Array.from(
      new Set(reviewerConfigs.map((config) => config.scorecardId)),
    );

    if (uniqueScorecards.length === 0) {
      this.logger.warn(
        `Member reviewer configs missing scorecard IDs for challenge ${challengeId}, phase ${phaseId}`,
      );
      return null;
    }

    if (uniqueScorecards.length > 1) {
      this.logger.warn(
        `Multiple scorecard IDs detected for challenge ${challengeId}, phase ${phaseId}. Using ${uniqueScorecards[0]} for pending reviews`,
      );
    }

    return uniqueScorecards[0];
  }
}
