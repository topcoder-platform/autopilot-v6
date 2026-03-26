import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  type IChallenge,
  type IChallengeWinner,
  type IChallengePrizeSet,
  type IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import { FinanceApiService } from '../../finance/finance-api.service';
import { ReviewSummationApiService } from './review-summation-api.service';
import { POST_MORTEM_REVIEWER_ROLE_NAME } from '../constants/review.constants';
import { KafkaService } from '../../kafka/kafka.service';
import { KAFKA_TOPICS } from '../../kafka/constants/topics';
import { AutopilotOperator } from '../interfaces/autopilot.interface';
import { MarathonMatchApiService } from '../../marathon-match/marathon-match-api.service';
import { MemberApiService } from '../../member-api/member-api.service';
import { isMarathonMatchChallenge } from '../constants/challenge.constants';
import {
  challengeAllowsUnlimitedSubmissions,
  isRatedChallenge,
} from '../utils/challenge-metadata.utils';

/**
 * Completes challenges, derives winners, and coordinates downstream finance and
 * member statistics side effects through outbound service integrations.
 */
@Injectable()
export class ChallengeCompletionService {
  private readonly logger = new Logger(ChallengeCompletionService.name);
  private readonly rerateSupportedPairs = new Set([
    'DEVELOP::Challenge',
    'DATA_SCIENCE::MARATHON_MATCH',
  ]);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly financeApiService: FinanceApiService,
    private readonly memberApiService: MemberApiService,
    private readonly reviewSummationApiService: ReviewSummationApiService,
    private readonly configService: ConfigService,
    private readonly kafkaService: KafkaService,
    private readonly marathonMatchApiService: MarathonMatchApiService,
  ) {}

  /**
   * Resolves the member-api rerate track/type payload from the challenge names.
   * @param challenge Completed challenge snapshot from the Challenge API.
   * @returns Contract-compliant rerate identifiers, or `null` when the challenge is unsupported.
   * @throws Never. Unsupported or unrecognized values are logged and skipped.
   */
  private getSupportedReratePayload(
    challenge: IChallenge,
  ): { trackId: string; typeId: string } | null {
    const trackId = this.normalizeMemberStatsTrackId(challenge.track);
    const typeId = this.normalizeMemberStatsTypeId(challenge.type);

    if (!trackId || !typeId) {
      this.logger.warn(
        `Skipping member stats rerate for challenge ${challenge.id} because track or type could not be normalized from challenge names.`,
      );
      return null;
    }

    const pairKey = `${trackId}::${typeId}`;
    if (!this.rerateSupportedPairs.has(pairKey)) {
      this.logger.warn(
        `Skipping member stats rerate for challenge ${challenge.id} because rerates for ${trackId} / ${typeId} are not supported by member-api.`,
      );
      return null;
    }

    return { trackId, typeId };
  }

  /**
   * Maps challenge track names to the enum names accepted by member-api rerates.
   * @param track Challenge track name from challenge-api.
   * @returns Supported member-api track enum name, or `null` when no mapping exists.
   * @throws Never.
   */
  private normalizeMemberStatsTrackId(track?: string): string | null {
    const normalized = track?.trim().toUpperCase();
    if (!normalized) {
      return null;
    }

    if (normalized.includes('DATA') && normalized.includes('SCIENCE')) {
      return 'DATA_SCIENCE';
    }

    if (normalized.includes('DEVELOP') || normalized === 'DEV') {
      return 'DEVELOP';
    }

    return null;
  }

  /**
   * Maps challenge type names to the enum names accepted by member-api rerates.
   * @param type Challenge type name from challenge-api.
   * @returns Supported member-api type enum name, or `null` when no mapping exists.
   * @throws Never.
   */
  private normalizeMemberStatsTypeId(type?: string): string | null {
    const normalized = type
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (!normalized) {
      return null;
    }

    if (normalized === 'CHALLENGE') {
      return 'Challenge';
    }

    if (normalized === 'MARATHON_MATCH') {
      return 'MARATHON_MATCH';
    }

    return null;
  }

  /**
   * Schedules member stats refresh and rerate calls for the unique winner handles on a completed challenge.
   * @param challengeId Completed challenge identifier.
   * @param winners Winner records used to derive distinct member handles.
   * @param challengeSnapshot Optional challenge snapshot reused to avoid an extra lookup.
   * @returns Promise that resolves after the outbound calls have been scheduled.
   * @throws Never. Errors are logged and swallowed so completion remains idempotent.
   *
   * Usage:
   * Invoked by the completion paths after finance has been triggered so member-api
   * can refresh winner stats asynchronously without blocking challenge completion.
   * Rerates are only sent for explicitly rated challenges whose normalized track/type
   * names match the member-api contract.
   */
  private async triggerStatsRefreshForWinners(
    challengeId: string,
    winners: IChallengeWinner[],
    challengeSnapshot?: IChallenge,
  ): Promise<void> {
    try {
      const handles = Array.from(
        new Set(
          winners
            .map((winner) => winner.handle?.trim())
            .filter((handle): handle is string => Boolean(handle)),
        ),
      );

      if (!handles.length) {
        return;
      }

      for (const handle of handles) {
        void this.memberApiService.refreshMemberStats(handle, challengeId);
      }

      const challenge =
        challengeSnapshot ??
        (await this.challengeApiService.getChallengeById(challengeId));

      if (!isRatedChallenge(challenge)) {
        return;
      }

      const reratePayload = this.getSupportedReratePayload(challenge);
      if (!reratePayload) {
        return;
      }

      for (const handle of handles) {
        void this.memberApiService.rerateMemberStats(
          handle,
          challengeId,
          reratePayload.trackId,
          reratePayload.typeId,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to trigger member stats refresh for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Synchronize review-api `challengeResult` rows for one completed challenge.
   * @param challengeId Completed challenge identifier.
   * @param challenge Challenge snapshot supplying metadata and timing context.
   * @param placementWinners Placement winners used to preserve prize placements in the result rows.
   * @returns Promise that resolves after the sync attempt finishes.
   * @throws Never. Failures are logged and swallowed so challenge completion remains idempotent.
   */
  private async syncChallengeResults(
    challengeId: string,
    challenge: IChallenge,
    placementWinners: IChallengeWinner[],
  ): Promise<void> {
    try {
      const createdAt = this.resolveChallengeResultCreatedAt(challenge);
      await this.reviewService.syncChallengeResultsForChallenge(challengeId, {
        placementWinners: placementWinners.map((winner) => ({
          userId: winner.userId,
          placement: winner.placement,
        })),
        allowUnlimitedSubmissions: challengeAllowsUnlimitedSubmissions(
          challenge,
          (message) => this.logger.warn(message),
        ),
        ratedChallenge: isRatedChallenge(challenge),
        actor: 'autopilot',
        createdAt,
        updatedAt: new Date(),
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to sync challenge results for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Resolve the canonical creation timestamp for persisted `challengeResult` rows.
   * @param challenge Challenge snapshot whose lifecycle timestamps should be inspected.
   * @returns Best-effort completion timestamp, falling back to the current time.
   * @throws Never.
   */
  private resolveChallengeResultCreatedAt(challenge: IChallenge): Date {
    const candidateValues = [
      challenge.endDate,
      challenge.updated,
      challenge.created,
    ];

    for (const candidateValue of candidateValues) {
      if (!candidateValue) {
        continue;
      }

      const parsed = new Date(candidateValue);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date();
  }

  private async ensureCancelledPostMortem(challengeId: string): Promise<void> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      // Resolve scorecard for post-mortem: prefer env var; fallback to name
      const configuredScorecardId =
        this.configService.get<string | null>(
          'autopilot.postMortemScorecardId',
        ) ?? null;

      let scorecardId: string | null = configuredScorecardId;

      if (!scorecardId) {
        try {
          scorecardId = await this.reviewService.getScorecardIdByName(
            'Topcoder Post Mortem',
          );
        } catch {
          // Already logged inside review service; leave as null
        }
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

      // Assign to Post-Mortem resources if scorecard is available
      if (scorecardId) {
        const reviewerAndCopilotResources =
          await this.resourcesService.getResourcesByRoleNames(challengeId, [
            'Reviewer',
            'Copilot',
          ]);
        const postMortemResources =
          await this.resourcesService.ensureResourcesForMembers(
            challengeId,
            reviewerAndCopilotResources,
            POST_MORTEM_REVIEWER_ROLE_NAME,
          );

        let createdCount = 0;
        for (const resource of postMortemResources) {
          try {
            const { created } = await this.reviewService.createPendingReview(
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
            `Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId} (${POST_MORTEM_REVIEWER_ROLE_NAME}).`,
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

  private countPrizesByType(
    prizeSets: IChallengePrizeSet[],
    prizeType: PrizeSetTypeEnum,
  ): number {
    if (!Array.isArray(prizeSets) || prizeSets.length === 0) {
      return 0;
    }

    return prizeSets.reduce((total, prizeSet) => {
      if (!prizeSet || prizeSet.type !== prizeType) {
        return total;
      }

      const prizeCount = prizeSet.prizes?.length ?? 0;
      return total + prizeCount;
    }, 0);
  }

  private countPlacementPrizes(prizeSets: IChallengePrizeSet[]): number {
    return this.countPrizesByType(prizeSets, PrizeSetTypeEnum.PLACEMENT);
  }

  private countCheckpointPrizes(prizeSets: IChallengePrizeSet[]): number {
    return this.countPrizesByType(prizeSets, PrizeSetTypeEnum.CHECKPOINT);
  }

  private getSubmissionTimestamp(submittedDate: Date | null): number {
    if (!submittedDate) {
      return 0;
    }

    const timestamp = submittedDate.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private buildWinnerRecord(
    challengeId: string,
    summary: { submissionId: string; memberId: string | null },
    handleMap: Map<string, string>,
    placement: number,
    type: PrizeSetTypeEnum,
  ): IChallengeWinner | null {
    const recordTypeLabel =
      type === PrizeSetTypeEnum.PASSED_REVIEW
        ? 'passed review placement'
        : 'winner placement';

    if (!summary.memberId) {
      this.logger.warn(
        `Skipping ${recordTypeLabel} for submission ${summary.submissionId} on challenge ${challengeId} because memberId is missing.`,
      );
      return null;
    }

    const memberId = summary.memberId.trim();
    if (!memberId) {
      this.logger.warn(
        `Skipping ${recordTypeLabel} for submission ${summary.submissionId} on challenge ${challengeId} because memberId is blank.`,
      );
      return null;
    }

    const numericMemberId = Number(memberId);
    if (!Number.isFinite(numericMemberId)) {
      this.logger.warn(
        `Skipping ${recordTypeLabel} for submission ${summary.submissionId} on challenge ${challengeId} because memberId ${memberId} is not numeric.`,
      );
      return null;
    }

    return {
      userId: numericMemberId,
      handle: handleMap.get(memberId) ?? memberId,
      placement,
      type,
    };
  }

  private async publishChallengeCompletionUpdate(
    challengeId: string,
    winners: IChallengeWinner[],
    challengeSnapshot?: IChallenge,
  ): Promise<void> {
    try {
      const challenge =
        challengeSnapshot ??
        (await this.challengeApiService.getChallengeById(challengeId));
      const timestamp = new Date().toISOString();

      const payload = {
        id: challenge.id,
        projectId: challenge.projectId,
        status: ChallengeStatusEnum.COMPLETED,
        description: challenge.description ?? '',
        tags: challenge.tags ?? [],
        skills: challenge.skills ?? [],
        winners: winners.map((winner) => ({
          userId: winner.userId,
          placement: winner.placement,
          handle: winner.handle,
        })),
        operator: AutopilotOperator.SYSTEM,
        date: timestamp,
      };

      const message = {
        topic: KAFKA_TOPICS.CHALLENGE_UPDATED,
        originator: 'autopilot-service',
        timestamp,
        mimeType: 'application/json',
        payload,
      };

      await this.kafkaService.produce(KAFKA_TOPICS.CHALLENGE_UPDATED, message);
      this.logger.log(
        `Published challenge update for completed challenge ${challengeId}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to publish challenge update for completed challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async assignCheckpointWinners(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      const checkpointPrizeLimit = this.countCheckpointPrizes(
        challenge.prizeSets ?? [],
      );

      if (checkpointPrizeLimit <= 0) {
        this.logger.log(
          `No checkpoint prizes configured for challenge ${challengeId}; clearing checkpoint winners.`,
        );
        await this.challengeApiService.setCheckpointWinners(challengeId, []);
        return;
      }

      const topScores = await this.reviewService.getTopCheckpointReviewScores(
        challengeId,
        phaseId,
        checkpointPrizeLimit,
      );

      if (!topScores.length) {
        this.logger.warn(
          `Checkpoint Review closed for challenge ${challengeId}, but no completed checkpoint reviews were found; clearing checkpoint winners.`,
        );
        await this.challengeApiService.setCheckpointWinners(challengeId, []);
        return;
      }

      const memberIds = Array.from(
        new Set(
          topScores
            .map((score) => score.memberId?.trim())
            .filter((id): id is string => Boolean(id)),
        ),
      );

      const handleMap = await this.resourcesService.getMemberHandleMap(
        challengeId,
        memberIds,
      );

      const winners: IChallengeWinner[] = [];
      const seenMembers = new Set<string>();
      const seenSubmissions = new Set<string>();

      for (const score of topScores) {
        const memberId = score.memberId.trim();
        const submissionId = score.submissionId.trim();

        if (!memberId || !submissionId) {
          continue;
        }

        if (seenMembers.has(memberId) || seenSubmissions.has(submissionId)) {
          continue;
        }

        const numericMemberId = Number(memberId);
        if (!Number.isFinite(numericMemberId)) {
          this.logger.warn(
            `Skipping checkpoint winner assignment for submission ${submissionId} on challenge ${challengeId}: memberId ${memberId} is not numeric.`,
          );
          continue;
        }

        winners.push({
          userId: numericMemberId,
          handle: handleMap.get(memberId) ?? memberId,
          placement: winners.length + 1,
          type: PrizeSetTypeEnum.CHECKPOINT,
        });

        seenMembers.add(memberId);
        seenSubmissions.add(submissionId);

        if (winners.length >= checkpointPrizeLimit) {
          break;
        }
      }

      await this.challengeApiService.setCheckpointWinners(challengeId, winners);

      this.logger.log(
        `Assigned ${winners.length} checkpoint winner(s) for challenge ${challengeId} after closing phase ${phaseId}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to assign checkpoint winners for challenge ${challengeId} after closing phase ${phaseId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async finalizeChallenge(challengeId: string): Promise<boolean> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    const normalizedStatus = (challenge.status ?? '').toUpperCase();
    if (normalizedStatus !== ChallengeStatusEnum.ACTIVE) {
      if (
        normalizedStatus === ChallengeStatusEnum.COMPLETED ||
        normalizedStatus === ChallengeStatusEnum.CANCELLED_FAILED_REVIEW
      ) {
        this.logger.log(
          `Challenge ${challengeId} is already ${challenge.status}; ensuring finance payments are generated.`,
        );
        void this.financeApiService.generateChallengePayments(challengeId);
      }
      if (normalizedStatus === ChallengeStatusEnum.COMPLETED) {
        const placementWinners = (challenge.winners ?? []).filter(
          (winner) =>
            winner.type === undefined ||
            winner.type === PrizeSetTypeEnum.PLACEMENT,
        );
        void this.syncChallengeResults(
          challengeId,
          challenge,
          placementWinners,
        );
        void this.triggerStatsRefreshForWinners(
          challengeId,
          challenge.winners ?? [],
          challenge,
        );
      }
      this.logger.log(
        `Challenge ${challengeId} is not ACTIVE (status: ${challenge.status}); skipping finalization attempt.`,
      );
      return true;
    }

    await this.reviewSummationApiService.finalizeSummations(challengeId);

    if (isMarathonMatchChallenge(challenge.type)) {
      const marathonMatchConfig =
        await this.marathonMatchApiService.getConfig(challengeId);
      if (marathonMatchConfig?.relativeScoringEnabled) {
        this.logger.debug(
          `Challenge ${challengeId} is a Marathon Match with relative scoring enabled; using persisted aggregate scores from review summations.`,
        );
      }
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

      const timeDiff =
        this.getSubmissionTimestamp(a.submittedDate) -
        this.getSubmissionTimestamp(b.submittedDate);
      if (timeDiff !== 0) {
        return timeDiff;
      }

      return a.submissionId.localeCompare(b.submissionId);
    });

    const memberIds = Array.from(
      new Set(
        sortedSummaries
          .map((summary) => summary.memberId?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const handleMap = await this.resourcesService.getMemberHandleMap(
      challengeId,
      memberIds,
    );

    const placementPrizeLimit = this.countPlacementPrizes(
      challenge.prizeSets ?? [],
    );
    const placementWinnerLimit =
      placementPrizeLimit > 0 ? placementPrizeLimit : sortedSummaries.length;
    const placementSummaries = sortedSummaries.slice(0, placementWinnerLimit);
    const passedReviewSummaries = sortedSummaries.slice(placementWinnerLimit);

    const placementWinners = placementSummaries
      .map((summary, index) =>
        this.buildWinnerRecord(
          challengeId,
          summary,
          handleMap,
          index + 1,
          PrizeSetTypeEnum.PLACEMENT,
        ),
      )
      .filter((winner): winner is IChallengeWinner => winner !== null);

    const passedReviewWinners = passedReviewSummaries
      .map((summary, index) =>
        this.buildWinnerRecord(
          challengeId,
          summary,
          handleMap,
          index + 1,
          PrizeSetTypeEnum.PASSED_REVIEW,
        ),
      )
      .filter((winner): winner is IChallengeWinner => winner !== null);

    const winners = [...placementWinners, ...passedReviewWinners];

    await this.challengeApiService.completeChallenge(challengeId, winners);
    await this.syncChallengeResults(challengeId, challenge, placementWinners);
    // Trigger finance payments generation after marking the challenge as completed
    void this.financeApiService.generateChallengePayments(challengeId);
    // Trigger member stats refresh and rerating for winning members.
    void this.triggerStatsRefreshForWinners(
      challengeId,
      placementWinners,
      challenge,
    );
    await this.publishChallengeCompletionUpdate(
      challengeId,
      placementWinners,
      challenge,
    );
    this.logger.log(
      `Marked challenge ${challengeId} as COMPLETED with ${placementWinners.length} winner(s) and ${passedReviewWinners.length} passed review record(s).`,
    );
    return true;
  }

  async completeChallengeWithWinners(
    challengeId: string,
    winners: IChallengeWinner[],
    context?: { reason?: string },
  ): Promise<void> {
    await this.challengeApiService.completeChallenge(challengeId, winners);
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);
    const placementWinners = winners.filter(
      (winner) =>
        winner.type === undefined || winner.type === PrizeSetTypeEnum.PLACEMENT,
    );
    await this.syncChallengeResults(challengeId, challenge, placementWinners);
    // Trigger finance payments generation after marking the challenge as completed
    void this.financeApiService.generateChallengePayments(challengeId);
    // Trigger member stats refresh and rerating for winning members.
    void this.triggerStatsRefreshForWinners(challengeId, winners, challenge);
    await this.publishChallengeCompletionUpdate(
      challengeId,
      winners,
      challenge,
    );
    const suffix = context?.reason ? ` (${context.reason})` : '';
    this.logger.log(
      `Marked challenge ${challengeId} as COMPLETED with ${winners.length} winner(s)${suffix}.`,
    );
  }
}
