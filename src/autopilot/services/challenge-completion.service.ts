import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { IChallengeWinner } from '../../challenge/interfaces/challenge.interface';

@Injectable()
export class ChallengeCompletionService {
  private readonly logger = new Logger(ChallengeCompletionService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
  ) {}

  async finalizeChallenge(challengeId: string): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (
      challenge.status === 'COMPLETED' &&
      challenge.winners &&
      challenge.winners.length
    ) {
      this.logger.log(
        `Challenge ${challengeId} is already completed with winners; skipping finalization.`,
      );
      return;
    }

    const scoreRows = await this.reviewService.getTopFinalReviewScores(
      challengeId,
      3,
    );

    if (!scoreRows.length) {
      this.logger.warn(
        `No final review scores found for challenge ${challengeId}; marking completed without winners.`,
      );
      await this.challengeApiService.completeChallenge(challengeId, []);
      return;
    }

    const memberIds = scoreRows.map((row) => row.memberId);
    const handleMap = await this.resourcesService.getMemberHandleMap(
      challengeId,
      memberIds,
    );

    const winners: IChallengeWinner[] = [];
    for (const [index, row] of scoreRows.entries()) {
      const numericMemberId = Number(row.memberId);
      if (!Number.isFinite(numericMemberId)) {
        this.logger.warn(
          `Skipping winner placement ${index + 1} for challenge ${challengeId} because memberId ${row.memberId} is not numeric.`,
        );
        continue;
      }

      winners.push({
        userId: numericMemberId,
        handle: handleMap.get(row.memberId) ?? row.memberId,
        placement: winners.length + 1,
      });

      if (winners.length >= 3) {
        break;
      }
    }

    if (!winners.length) {
      this.logger.warn(
        `Unable to derive any numeric winners for challenge ${challengeId}; marking completed without winners.`,
      );
      await this.challengeApiService.completeChallenge(challengeId, []);
      return;
    }

    await this.challengeApiService.completeChallenge(challengeId, winners);
    this.logger.log(
      `Marked challenge ${challengeId} as COMPLETED with ${winners.length} winner(s).`,
    );
  }
}
