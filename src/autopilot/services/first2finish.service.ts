import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { SchedulerService } from './scheduler.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  AutopilotOperator,
  ReviewCompletedPayload,
} from '../interfaces/autopilot.interface';
import {
  ITERATIVE_REVIEW_PHASE_NAME,
  PHASE_ROLE_MAP,
  SUBMISSION_PHASE_NAME,
} from '../constants/review.constants';

const FIRST2FINISH_TYPE = 'first2finish';

@Injectable()
export class First2FinishService {
  private readonly logger = new Logger(First2FinishService.name);
  private readonly iterativeRoles: string[];

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly schedulerService: SchedulerService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
  ) {
    this.iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];
  }

  isChallengeActive(status?: string): boolean {
    return (status ?? '').toUpperCase() === 'ACTIVE';
  }

  isFirst2FinishChallenge(type?: string): boolean {
    return (type ?? '').toLowerCase() === FIRST2FINISH_TYPE;
  }

  async handleSubmissionByChallengeId(
    challengeId: string,
    submissionId?: string,
  ): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (!this.isFirst2FinishChallenge(challenge.type)) {
      this.logger.debug(
        'Skipping submission aggregate for non-First2Finish challenge',
        {
          submissionId,
          challengeId,
          challengeType: challenge.type,
        },
      );
      return;
    }

    await this.processFirst2FinishSubmission(challenge, submissionId);
  }

  async handleIterativeReviewerAdded(challenge: IChallenge): Promise<void> {
    await this.processFirst2FinishSubmission(challenge);
  }

  async handleIterativeReviewCompletion(
    challenge: IChallenge,
    phase: IPhase,
    review: {
      score?: number | string | null;
      scorecardId: string | null;
      resourceId: string;
      submissionId: string | null;
      phaseId: string | null;
    },
    payload: ReviewCompletedPayload,
  ): Promise<void> {
    const scorecardId = review.scorecardId ?? payload.scorecardId;
    const passingScore =
      await this.reviewService.getScorecardPassingScore(scorecardId);

    const rawScore =
      typeof review.score === 'number'
        ? review.score
        : Number(review.score ?? payload.initialScore ?? 0);
    const finalScore = Number.isFinite(rawScore)
      ? Number(rawScore)
      : Number(payload.initialScore ?? 0);

    await this.schedulerService.advancePhase({
      projectId: challenge.projectId,
      challengeId: challenge.id,
      phaseId: phase.id,
      phaseTypeName: phase.name,
      state: 'END',
      operator: AutopilotOperator.SYSTEM,
      projectStatus: challenge.status,
    });

    if (passingScore !== null && finalScore >= passingScore) {
      this.logger.log(
        `Iterative review passed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore} / passing ${passingScore}).`,
      );

      const submissionPhase = challenge.phases.find(
        (p) => p.name === SUBMISSION_PHASE_NAME && p.isOpen,
      );

      if (submissionPhase) {
        await this.schedulerService.advancePhase({
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: submissionPhase.id,
          phaseTypeName: submissionPhase.name,
          state: 'END',
          operator: AutopilotOperator.SYSTEM,
          projectStatus: challenge.status,
        });
      }
    } else {
      this.logger.log(
        `Iterative review failed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore}, passing ${passingScore ?? 'N/A'}).`,
      );
      await this.prepareNextIterativeReview(challenge.id);
    }
  }

  private async processFirst2FinishSubmission(
    challenge: IChallenge,
    submissionId?: string,
  ): Promise<void> {
    if (!this.isFirst2FinishChallenge(challenge.type)) {
      return;
    }

    const iterativePhase = challenge.phases?.find(
      (phase) => phase.name === ITERATIVE_REVIEW_PHASE_NAME,
    );

    if (!iterativePhase) {
      this.logger.warn(
        `No Iterative Review phase configured for First2Finish challenge ${challenge.id}.`,
      );
      return;
    }

    const reviewers = await this.resourcesService.getReviewerResources(
      challenge.id,
      this.iterativeRoles,
    );

    if (!reviewers.length) {
      this.logger.warn(
        `Awaiting iterative reviewer assignment for challenge ${challenge.id} before processing submission ${submissionId ?? 'latest'}.`,
      );
      return;
    }

    const scorecardId = this.getScorecardIdForPhase(challenge, iterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challenge.id}.`,
      );
      return;
    }

    if (!iterativePhase.isOpen) {
      const openResult = await this.challengeApiService.advancePhase(
        challenge.id,
        iterativePhase.id,
        'open',
      );

      if (!openResult.success) {
        this.logger.warn(
          `Failed to open Iterative Review phase ${iterativePhase.id} on challenge ${challenge.id}: ${openResult.message}`,
        );
        return;
      }
    }

    const preferredSubmissionId = submissionId;
    const assigned = await this.assignNextIterativeReview(
      challenge.id,
      iterativePhase,
      reviewers[0].id,
      scorecardId,
      preferredSubmissionId,
    );

    if (!assigned) {
      this.logger.debug(
        `No additional submissions available for iterative review on challenge ${challenge.id}; closing phase.`,
      );

      await this.schedulerService.advancePhase({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: iterativePhase.id,
        phaseTypeName: iterativePhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });
    }
  }

  private async assignNextIterativeReview(
    challengeId: string,
    phase: IPhase,
    resourceId: string,
    scorecardId: string,
    preferredSubmissionId?: string,
  ): Promise<boolean> {
    const submissionIds =
      await this.reviewService.getAllSubmissionIdsOrdered(challengeId);

    if (!submissionIds.length) {
      return false;
    }

    const orderedIds = preferredSubmissionId
      ? [preferredSubmissionId, ...submissionIds]
      : submissionIds;

    const seen = new Set<string>();
    const uniqueIds = orderedIds.filter((id) => {
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });

    const existingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );

    for (const submissionId of uniqueIds) {
      const key = `${resourceId}:${submissionId}`;
      if (existingPairs.has(key)) {
        continue;
      }

      const created = await this.reviewService.createPendingReview(
        submissionId,
        resourceId,
        phase.id,
        scorecardId,
        challengeId,
      );

      if (created) {
        this.logger.log(
          `Assigned iterative review for submission ${submissionId} to resource ${resourceId} on challenge ${challengeId}.`,
        );
        return true;
      }
    }

    return false;
  }

  private async prepareNextIterativeReview(challengeId: string): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (!this.isChallengeActive(challenge.status)) {
      return;
    }

    const iterativePhase = challenge.phases?.find(
      (phase) => phase.name === ITERATIVE_REVIEW_PHASE_NAME,
    );

    if (!iterativePhase) {
      return;
    }

    const reviewers = await this.resourcesService.getReviewerResources(
      challengeId,
      this.iterativeRoles,
    );

    if (!reviewers.length) {
      this.logger.warn(
        `Awaiting iterative reviewer assignment for challenge ${challengeId} before processing next submission.`,
      );
      return;
    }

    const scorecardId = this.getScorecardIdForPhase(challenge, iterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challengeId}.`,
      );
      return;
    }

    if (!iterativePhase.isOpen) {
      const openResult = await this.challengeApiService.advancePhase(
        challengeId,
        iterativePhase.id,
        'open',
      );

      if (!openResult.success) {
        this.logger.warn(
          `Failed to reopen Iterative Review phase ${iterativePhase.id} on challenge ${challengeId}: ${openResult.message}`,
        );
        return;
      }
    }

    const assigned = await this.assignNextIterativeReview(
      challengeId,
      iterativePhase,
      reviewers[0].id,
      scorecardId,
    );

    if (!assigned) {
      this.logger.debug(
        `No additional submissions available for iterative review on challenge ${challengeId}; closing phase.`,
      );

      await this.schedulerService.advancePhase({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: iterativePhase.id,
        phaseTypeName: iterativePhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });
    }
  }

  private getScorecardIdForPhase(
    challenge: IChallenge,
    phase: IPhase,
  ): string | null {
    const configs = challenge.reviewers?.filter(
      (reviewer) => reviewer.phaseId === phase.phaseId && reviewer.scorecardId,
    );

    if (!configs?.length) {
      return null;
    }

    return configs[0].scorecardId ?? null;
  }
}
