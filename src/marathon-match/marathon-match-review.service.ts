import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IChallenge,
  IPhase,
} from '../challenge/interfaces/challenge.interface';
import {
  type ActiveContestSubmission,
  ReviewService,
} from '../review/review.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import { MarathonMatchApiService } from './marathon-match-api.service';

/**
 * Creates and dispatches Marathon Match SYSTEM reviews when the review phase opens.
 */
@Injectable()
export class MarathonMatchReviewService {
  private readonly logger = new Logger(MarathonMatchReviewService.name);

  constructor(
    private readonly marathonMatchApiService: MarathonMatchApiService,
    private readonly reviewService: ReviewService,
    private readonly configService: ConfigService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  /**
   * Prepares one pending SYSTEM review per latest submission and dispatches scoring.
   * Existing pending reviews are re-dispatched so transient failures do not strand
   * Marathon Match submissions in review.
   * @param challenge Challenge snapshot containing the opened review phase.
   * @param phase Open review phase that should receive Marathon Match system reviews.
   */
  async handleReviewPhaseOpened(
    challenge: IChallenge,
    phase: IPhase,
  ): Promise<void> {
    const challengeId = challenge.id;
    const systemResourceId = (
      this.configService.get<string>('marathonMatch.systemResourceId') || ''
    ).trim();

    if (!systemResourceId) {
      await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
        challengeId,
        status: 'INFO',
        source: MarathonMatchReviewService.name,
        details: {
          phaseId: phase.id,
          phaseName: phase.name,
          reason: 'missing-system-resource-id',
        },
      });
      this.logger.warn(
        `MARATHON_MATCH_SYSTEM_RESOURCE_ID is not configured; skipping Marathon Match review setup for challenge ${challengeId}.`,
      );
      return;
    }

    const marathonMatchConfig =
      await this.marathonMatchApiService.getConfig(challengeId);
    const reviewScorecardId = marathonMatchConfig?.reviewScorecardId?.trim();

    if (!reviewScorecardId) {
      await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
        challengeId,
        status: 'INFO',
        source: MarathonMatchReviewService.name,
        details: {
          phaseId: phase.id,
          phaseName: phase.name,
          reason: 'missing-review-scorecard',
        },
      });
      this.logger.warn(
        `Marathon Match config for challenge ${challengeId} did not provide reviewScorecardId; skipping system review creation.`,
      );
      return;
    }

    const activeSubmissions =
      await this.reviewService.getActiveContestSubmissions(challengeId);
    const latestSubmissions = this.selectLatestSubmissions(activeSubmissions);

    if (!latestSubmissions.length) {
      await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
        challengeId,
        status: 'INFO',
        source: MarathonMatchReviewService.name,
        details: {
          phaseId: phase.id,
          phaseName: phase.name,
          activeSubmissionCount: activeSubmissions.length,
          reason: 'no-latest-submissions',
        },
      });
      return;
    }

    let createdCount = 0;
    let dispatchAttemptCount = 0;
    let triggeredCount = 0;

    for (const submission of latestSubmissions) {
      let created = false;
      let reviewId: string | null = null;

      try {
        ({ created, reviewId } = await this.reviewService.createPendingReview(
          submission.id,
          systemResourceId,
          phase.id,
          reviewScorecardId,
          challengeId,
        ));

        if (created) {
          createdCount += 1;
        }

        await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
          challengeId,
          status: 'SUCCESS',
          source: MarathonMatchReviewService.name,
          details: {
            phaseId: phase.id,
            phaseName: phase.name,
            submissionId: submission.id,
            memberId: submission.memberId ?? null,
            created,
            reviewId,
          },
        });

        if (!reviewId) {
          await this.dbLogger.logAction(
            'marathonMatch.handleReviewPhaseOpened',
            {
              challengeId,
              status: 'INFO',
              source: MarathonMatchReviewService.name,
              details: {
                phaseId: phase.id,
                phaseName: phase.name,
                submissionId: submission.id,
                memberId: submission.memberId ?? null,
                created,
                reviewId,
                step: 'dispatch-skipped',
                reason: 'missing-review-id',
              },
            },
          );
          continue;
        }

        dispatchAttemptCount += 1;
        this.logger.log(
          `Dispatching Marathon Match system scoring for challenge ${challengeId}, phase ${phase.id}, submission ${submission.id}, review ${reviewId} (${created ? 'new' : 'existing'} pending review).`,
        );
        await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
          challengeId,
          status: 'INFO',
          source: MarathonMatchReviewService.name,
          details: {
            phaseId: phase.id,
            phaseName: phase.name,
            submissionId: submission.id,
            memberId: submission.memberId ?? null,
            created,
            reviewId,
            step: 'dispatch-intent',
          },
        });
        await this.marathonMatchApiService.triggerSystemScore(
          reviewId,
          submission.id,
          challengeId,
        );
        triggeredCount += 1;
        this.logger.log(
          `Dispatched Marathon Match system scoring for challenge ${challengeId}, phase ${phase.id}, submission ${submission.id}, review ${reviewId}.`,
        );
        await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
          challengeId,
          status: 'SUCCESS',
          source: MarathonMatchReviewService.name,
          details: {
            phaseId: phase.id,
            phaseName: phase.name,
            submissionId: submission.id,
            memberId: submission.memberId ?? null,
            created,
            reviewId,
            step: 'dispatch-success',
          },
        });
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed to prepare Marathon Match system review for challenge ${challengeId}, phase ${phase.id}, submission ${submission.id}: ${err.message}`,
          err.stack,
        );
        await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
          challengeId,
          status: 'ERROR',
          source: MarathonMatchReviewService.name,
          details: {
            phaseId: phase.id,
            phaseName: phase.name,
            submissionId: submission.id,
            memberId: submission.memberId ?? null,
            created,
            reviewId,
            step: reviewId ? 'dispatch-error' : 'prepare-error',
            error: err.message,
            errorStack: err.stack ?? null,
          },
        });
      }
    }

    await this.dbLogger.logAction('marathonMatch.handleReviewPhaseOpened', {
      challengeId,
      status: 'SUCCESS',
      source: MarathonMatchReviewService.name,
      details: {
        phaseId: phase.id,
        phaseName: phase.name,
        activeSubmissionCount: activeSubmissions.length,
        latestSubmissionCount: latestSubmissions.length,
        createdCount,
        dispatchAttemptCount,
        triggeredCount,
      },
    });
  }

  /**
   * Mirrors the latest-submission filtering already used by PhaseReviewService.
   */
  private selectLatestSubmissions(
    submissions: ActiveContestSubmission[],
  ): ActiveContestSubmission[] {
    if (!submissions.length) {
      return [];
    }

    const selected: ActiveContestSubmission[] = [];
    const addedKeys = new Set<string>();

    for (const submission of submissions) {
      if (!submission.isLatest) {
        continue;
      }

      const key = submission.memberId ?? submission.id;
      if (addedKeys.has(key)) {
        continue;
      }

      selected.push(submission);
      addedKeys.add(key);
    }

    return selected;
  }
}
