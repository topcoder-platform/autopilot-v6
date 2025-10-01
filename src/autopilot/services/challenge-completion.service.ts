import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  IChallengeWinner,
  type IChallengePrizeSet,
} from '../../challenge/interfaces/challenge.interface';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';

@Injectable()
export class ChallengeCompletionService {
  private readonly logger = new Logger(ChallengeCompletionService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
  ) {}

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
    this.logger.log(
      `Marked challenge ${challengeId} as COMPLETED with ${winners.length} winner(s).`,
    );
    return true;
  }
}
