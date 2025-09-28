import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  TOPGEAR_SUBMISSION_PHASE_NAME,
  isSubmissionPhaseName,
} from '../constants/review.constants';
import {
  describeChallengeType,
  isFirst2FinishChallenge as isSupportedChallengeType,
  isTopgearTaskChallenge,
} from '../constants/challenge.constants';
import { isActiveStatus } from '../utils/config.utils';
import { selectScorecardId } from '../utils/reviewer.utils';

@Injectable()
export class First2FinishService {
  private readonly logger = new Logger(First2FinishService.name);
  private readonly iterativeRoles: string[];
  private readonly iterativeReviewDurationMs: number;

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly schedulerService: SchedulerService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
  ) {
    this.iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];

    const configuredDuration = this.configService.get<number | string>(
      'autopilot.iterativeReviewDurationHours',
    );
    const parsedDuration = Number(configuredDuration);
    const normalizedHours =
      Number.isFinite(parsedDuration) && parsedDuration > 0
        ? parsedDuration
        : 24;
    this.iterativeReviewDurationMs = normalizedHours * 60 * 60 * 1000;
  }

  isChallengeActive(status?: string): boolean {
    return (status ?? '').toUpperCase() === 'ACTIVE';
  }

  isFirst2FinishChallenge(type?: string): boolean {
    return isSupportedChallengeType(type);
  }

  async handleSubmissionByChallengeId(
    challengeId: string,
    submissionId?: string,
  ): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (!this.isFirst2FinishChallenge(challenge.type)) {
      this.logger.debug(
        'Skipping submission aggregate for unsupported challenge type',
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

    if (finalScore >= passingScore) {
      this.logger.log(
        `Iterative review passed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore} / passing ${passingScore}).`,
      );

      const submissionPhase = challenge.phases.find(
        (p) => isSubmissionPhaseName(p.name) && p.isOpen,
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
        `Iterative review failed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore}, passing ${passingScore}).`,
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
        `No Iterative Review phase configured for ${describeChallengeType(challenge.type)} challenge ${challenge.id}.`,
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

    const scorecardId = this.pickIterativeScorecard(challenge, iterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challenge.id}.`,
      );
      return;
    }

    const activePhase = await this.ensureIterativePhaseOpen(
      challenge,
      iterativePhase,
    );

    if (!activePhase) {
      return;
    }

    const preferredSubmissionId = submissionId;
    const assigned = await this.assignNextIterativeReview(
      challenge.id,
      activePhase,
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
        phaseId: activePhase.id,
        phaseTypeName: activePhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });
      return;
    }

    await this.scheduleIterativeReviewClosure(challenge, activePhase);
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

    if (!isActiveStatus(challenge.status)) {
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

    const scorecardId = this.pickIterativeScorecard(challenge, iterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challengeId}.`,
      );
      return;
    }

    const activePhase = await this.ensureIterativePhaseOpen(
      challenge,
      iterativePhase,
    );

    if (!activePhase) {
      return;
    }

    const assigned = await this.assignNextIterativeReview(
      challengeId,
      activePhase,
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
        phaseId: activePhase.id,
        phaseTypeName: activePhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });
      return;
    }

    await this.scheduleIterativeReviewClosure(challenge, activePhase);
  }

  private pickIterativeScorecard(
    challenge: IChallenge,
    phase: IPhase,
  ): string | null {
    return selectScorecardId(
      challenge.reviewers ?? [],
      () => null,
      () => null,
      phase.phaseId,
    );
  }

  private async ensureIterativePhaseOpen(
    challenge: IChallenge,
    phase: IPhase,
  ): Promise<IPhase | null> {
    if (phase.isOpen) {
      return phase;
    }

    const openResult = await this.challengeApiService.advancePhase(
      challenge.id,
      phase.id,
      'open',
    );

    if (!openResult.success) {
      this.logger.warn(
        `Failed to open Iterative Review phase ${phase.id} on challenge ${challenge.id}: ${openResult.message}`,
      );
      return null;
    }

    const refreshedPhase =
      openResult.updatedPhases?.find((current) => current.id === phase.id) ??
      phase;

    return {
      ...phase,
      ...refreshedPhase,
      isOpen: true,
      actualStartDate:
        refreshedPhase.actualStartDate ??
        phase.actualStartDate ??
        new Date().toISOString(),
    };
  }

  private async scheduleIterativeReviewClosure(
    challenge: IChallenge,
    phase: IPhase,
  ): Promise<void> {
    const startTime = phase.actualStartDate
      ? new Date(phase.actualStartDate).getTime()
      : Date.now();
    const deadline = Math.max(
      startTime + this.iterativeReviewDurationMs,
      Date.now(),
    );
    const deadlineIso = new Date(deadline).toISOString();

    try {
      await this.schedulerService.schedulePhaseTransition({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: phase.id,
        phaseTypeName: phase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
        projectStatus: challenge.status,
        date: deadlineIso,
      });
      this.logger.debug(
        `Scheduled iterative review phase ${phase.id} closure for challenge ${challenge.id} at ${deadlineIso}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to schedule iterative review closure for challenge ${challenge.id}, phase ${phase.id}: ${err.message}`,
        err.stack,
      );
    }
  }
}
