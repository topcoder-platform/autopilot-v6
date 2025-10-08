import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  getRoleNamesForPhase,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
  POST_MORTEM_PHASE_NAME,
} from '../constants/review.constants';
import {
  getMemberReviewerConfigs,
  getReviewerConfigsForPhase,
  selectScorecardId,
} from '../utils/reviewer.utils';
import { isTopgearTaskChallenge } from '../constants/challenge.constants';

@Injectable()
export class PhaseReviewService {
  private readonly logger = new Logger(PhaseReviewService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
  ) {}

  async handlePhaseOpened(challengeId: string, phaseId: string): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);
    const phase = challenge.phases.find((p) => p.id === phaseId);

    if (!phase) {
      this.logger.warn(
        `Unable to locate phase ${phaseId} for challenge ${challengeId} when creating pending reviews`,
      );
      return;
    }

    const isReviewPhase = REVIEW_PHASE_NAMES.has(phase.name);
    const isScreeningPhase = SCREENING_PHASE_NAMES.has(phase.name);
    const isApprovalPhase = APPROVAL_PHASE_NAMES.has(phase.name);

    if (!isReviewPhase && !isScreeningPhase && !isApprovalPhase) {
      return;
    }

    // Special handling for Post-Mortem: create challenge-level pending reviews (no submissions)
    if (phase.name === POST_MORTEM_PHASE_NAME) {
      // Determine scorecard
      let scorecardId: string | null = null;
      if (isTopgearTaskChallenge(challenge.type)) {
        scorecardId =
          this.configService.get<string | null>(
            'autopilot.topgearPostMortemScorecardId',
          ) ?? null;
        if (!scorecardId) {
          try {
            scorecardId = await this.reviewService.getScorecardIdByName(
              'Topgear Task Post Mortem',
            );
          } catch (_) {
            // Logged inside review service; continue with null
          }
        }
      } else {
        scorecardId =
          this.configService.get<string | null>(
            'autopilot.postMortemScorecardId',
          ) ?? null;

        // Fallback to the standard Topcoder Post Mortem scorecard by name
        if (!scorecardId) {
          try {
            scorecardId = await this.reviewService.getScorecardIdByName(
              'Topcoder Post Mortem',
            );
          } catch (_) {
            // Logged inside review service; continue with null
          }
        }
      }

      if (!scorecardId) {
        this.logger.warn(
          `Post-mortem scorecard is not configured; skipping review creation for challenge ${challengeId}, phase ${phase.id}.`,
        );
        return;
      }

      const roleNames = getRoleNamesForPhase(phase.name);
      const reviewerResources = await this.resourcesService.getReviewerResources(
        challengeId,
        roleNames,
      );

      if (!reviewerResources.length) {
        this.logger.log(
          `No resources found for post-mortem roles on challenge ${challengeId}; skipping review creation for phase ${phase.id}.`,
        );
        return;
      }

      let createdCount = 0;
      for (const resource of reviewerResources) {
        try {
          const created = await this.reviewService.createPendingReview(
            null,
            resource.id,
            phase.id,
            scorecardId,
            challengeId,
          );
          if (created) {
            createdCount++;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to create post-mortem review for challenge ${challengeId}, phase ${phase.id}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      if (createdCount > 0) {
        this.logger.log(
          `Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId}, phase ${phase.id}.`,
        );
      }
      return;
    }

    // Determine reviewer configs for scorecard selection.
    // For screening phases, configs may not be marked isMemberReview, so include all for the phase.
    const reviewerConfigs = (
      isScreeningPhase
        ? getReviewerConfigsForPhase(challenge.reviewers, phase.phaseId)
        : getMemberReviewerConfigs(challenge.reviewers, phase.phaseId)
    ).filter((config) => Boolean(config.scorecardId));

    if (!reviewerConfigs.length) {
      this.logger.log(
        `No member review configurations found for phase ${phase.name} (${phase.id}) on challenge ${challengeId}; skipping review creation`,
      );
      return;
    }

    // Select scorecard
    // For screening phases, reviewer configs may not be flagged as member reviews.
    // Use any configured scorecard IDs for the phase as-is (without re-filtering by isMemberReview).
    let scorecardId: string | null;
    if (isScreeningPhase) {
      const uniqueScorecards = Array.from(
        new Set(
          reviewerConfigs
            .map((config) => config.scorecardId)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (uniqueScorecards.length === 0) {
        this.logger.warn(
          `Reviewer configs missing scorecard IDs for challenge ${challengeId}, phase ${phase.id}`,
        );
        return;
      }

      if (uniqueScorecards.length > 1) {
        this.logger.warn(
          `Multiple scorecard IDs detected for challenge ${challengeId}, phase ${phase.id}. Using ${uniqueScorecards[0]} for pending reviews`,
        );
      }

      scorecardId = uniqueScorecards[0] ?? null;
    } else {
      scorecardId = selectScorecardId(
        reviewerConfigs,
        () =>
          this.logger.warn(
            `Member reviewer configs missing scorecard IDs for challenge ${challengeId}, phase ${phase.id}`,
          ),
        (choices) =>
          this.logger.warn(
            `Multiple scorecard IDs detected for challenge ${challengeId}, phase ${phase.id}. Using ${choices[0]} for pending reviews`,
          ),
      );
    }
    if (!scorecardId) {
      return;
    }

    const roleNames = getRoleNamesForPhase(phase.name);
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

    let submissionIds: string[] = [];
    if (isApprovalPhase) {
      // Only the top final-scoring submission (winner) should be reviewed
      const winners = await this.reviewService.getTopFinalReviewScores(
        challengeId,
        1,
      );
      submissionIds = winners.map((w) => w.submissionId);
    } else if (phase.name === 'Checkpoint Review' || phase.name === 'Checkpoint Screening') {
      submissionIds = await this.reviewService.getActiveCheckpointSubmissionIds(
        challengeId,
      );
    } else {
      // Default to contest submissions for standard Review/Screening
      submissionIds = await this.reviewService.getActiveContestSubmissionIds(
        challengeId,
      );
    }
    if (!submissionIds.length) {
      this.logger.log(
        `No submissions found for challenge ${challengeId}; skipping review creation for phase ${phase.name}`,
      );
      return;
    }

    const existingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );

    let createdCount = 0;
    for (const resource of reviewerResources) {
      for (const submissionId of submissionIds) {
        const key = `${resource.id}:${submissionId}`;
        if (existingPairs.has(key)) {
          continue;
        }

        try {
          const created = await this.reviewService.createPendingReview(
            submissionId,
            resource.id,
            phase.id,
            scorecardId,
            challengeId,
          );
          existingPairs.add(key);
          if (created) {
            createdCount++;
          }
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
}
