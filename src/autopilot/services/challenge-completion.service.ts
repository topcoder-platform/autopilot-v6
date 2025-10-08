import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  IChallengeWinner,
  type IChallengePrizeSet,
} from '../../challenge/interfaces/challenge.interface';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import { IPhase } from '../../challenge/interfaces/challenge.interface';
import { FinanceApiService } from '../../finance/finance-api.service';

@Injectable()
export class ChallengeCompletionService {
  private readonly logger = new Logger(ChallengeCompletionService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly financeApiService: FinanceApiService,
  ) {}

  private async ensureCancelledPostMortem(
    challengeId: string,
  ): Promise<void> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      // Resolve scorecard for post-mortem: prefer env var; fallback to name
      let scorecardId: string | null = null;
      try {
        scorecardId = await this.reviewService.getScorecardIdByName(
          'Topcoder Post Mortem',
        );
      } catch (_) {
        // Already logged inside review service; leave as null
      }

      if (!scorecardId) {
        this.logger.warn(
          `Post-mortem scorecard 'Topcoder Post Mortem' not found; skipping post-mortem review creation for challenge ${challengeId}.`,
        );
      }

      // Determine a reasonable predecessor: last phase that has actually ended, else last phase in list
      const phases = challenge.phases ?? [];
      let predecessor: IPhase | undefined = phases
        .filter((p) => Boolean(p.actualEndDate))
        .sort((a, b) =>
          (a.actualEndDate ?? '').localeCompare(b.actualEndDate ?? ''),
        )
        .at(-1);
      if (!predecessor && phases.length) {
        predecessor = phases[phases.length - 1];
      }

      if (!predecessor) {
        this.logger.warn(
          `Unable to determine predecessor phase when creating post-mortem for challenge ${challengeId}; skipping creation.`,
        );
        return;
      }

      // Create or reuse Post-Mortem, open immediately
      const postMortem =
        await this.challengeApiService.createPostMortemPhasePreserving(
          challengeId,
          predecessor.id,
          72,
          true,
        );

      // Assign to Copilot(s) if scorecard is available
      if (scorecardId) {
        const copilots = await this.resourcesService.getResourcesByRoleNames(
          challengeId,
          ['Copilot'],
        );

        let createdCount = 0;
        for (const resource of copilots) {
          try {
            const created = await this.reviewService.createPendingReview(
              null,
              resource.id,
              postMortem.id,
              scorecardId,
              challengeId,
            );
            if (created) {
              createdCount++;
            }
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to create post-mortem review for challenge ${challengeId}, resource ${resource.id}: ${err.message}`,
              err.stack,
            );
          }
        }

        if (createdCount > 0) {
          this.logger.log(
            `Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId} (Copilot).`,
          );
        }
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Unable to create post-mortem phase for cancelled challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  private countPlacementPrizes(prizeSets: IChallengePrizeSet[]): number {
    if (!Array.isArray(prizeSets) || prizeSets.length === 0) {
      return 0;
    }

    return prizeSets.reduce((total, prizeSet) => {
      if (!prizeSet || prizeSet.type !== PrizeSetTypeEnum.PLACEMENT) {
        return total;
      }

      const prizeCount = prizeSet.prizes?.length ?? 0;
      return total + prizeCount;
    }, 0);
  }

  async finalizeChallenge(challengeId: string): Promise<boolean> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    const normalizedStatus = (challenge.status ?? '').toUpperCase();
    if (normalizedStatus !== ChallengeStatusEnum.ACTIVE) {
      this.logger.log(
        `Challenge ${challengeId} is not ACTIVE (status: ${challenge.status}); skipping finalization attempt.`,
      );
      return true;
    }

    const summaries =
      await this.reviewService.generateReviewSummaries(challengeId);

    if (!summaries.length) {
      if ((challenge.numOfSubmissions ?? 0) === 0) {
        this.logger.log(
          `Challenge ${challengeId} has no submissions; marking as CANCELLED_ZERO_SUBMISSIONS if not already handled.`,
        );
        await this.challengeApiService.cancelChallenge(
          challengeId,
          ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
        );
        // Ensure a Post-Mortem exists for the cancelled challenge and assign to Copilot
        await this.ensureCancelledPostMortem(challengeId);
        return true;
      }

      this.logger.warn(
        `Review data not yet available for challenge ${challengeId}; will retry finalization later.`,
      );
      return false;
    }

    const passingSummaries = summaries.filter((summary) => summary.isPassing);

    if (!passingSummaries.length) {
      this.logger.log(
        `No passing submissions detected for challenge ${challengeId}; marking as CANCELLED_FAILED_REVIEW.`,
      );
      await this.challengeApiService.cancelChallenge(
        challengeId,
        ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
      );
      // Ensure a Post-Mortem exists for the cancelled challenge and assign to Copilot
      await this.ensureCancelledPostMortem(challengeId);
      // Trigger finance payments generation for reviewer payments on failed review cancellation
      void this.financeApiService.generateChallengePayments(challengeId);
      return true;
    }

    const sortedSummaries = [...passingSummaries].sort((a, b) => {
      if (b.aggregateScore !== a.aggregateScore) {
        return b.aggregateScore - a.aggregateScore;
      }

      const timeA = a.submittedDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const timeB = b.submittedDate?.getTime() ?? Number.POSITIVE_INFINITY;
      if (timeA === timeB) {
        return 0;
      }
      return timeA - timeB;
    });

    const memberIds = sortedSummaries
      .map((summary) => summary.memberId)
      .filter((id): id is string => Boolean(id));

    const handleMap = await this.resourcesService.getMemberHandleMap(
      challengeId,
      memberIds,
    );

    const winners: IChallengeWinner[] = [];
    const placementPrizeLimit = this.countPlacementPrizes(
      challenge.prizeSets ?? [],
    );
    const maxWinnerCount =
      placementPrizeLimit > 0 ? placementPrizeLimit : sortedSummaries.length;

    for (const summary of sortedSummaries) {
      if (winners.length >= maxWinnerCount) {
        break;
      }

      if (!summary.memberId) {
        this.logger.warn(
          `Skipping winner placement for submission ${summary.submissionId} on challenge ${challengeId} because memberId is missing.`,
        );
        continue;
      }

      const numericMemberId = Number(summary.memberId);
      if (!Number.isFinite(numericMemberId)) {
        this.logger.warn(
          `Skipping winner placement for submission ${summary.submissionId} on challenge ${challengeId} because memberId ${summary.memberId} is not numeric.`,
        );
        continue;
      }

      winners.push({
        userId: numericMemberId,
        handle: handleMap.get(summary.memberId) ?? summary.memberId,
        placement: winners.length + 1,
      });
    }

    await this.challengeApiService.completeChallenge(challengeId, winners);
    // Trigger finance payments generation after marking the challenge as completed
    void this.financeApiService.generateChallengePayments(challengeId);
    this.logger.log(
      `Marked challenge ${challengeId} as COMPLETED with ${winners.length} winner(s).`,
    );
    return true;
  }
}
