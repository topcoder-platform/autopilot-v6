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
  REGISTRATION_PHASE_NAME,
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
  private readonly iterativeAssignmentRetryMs: number;
  private readonly iterativeAssignmentRetryTimers = new Map<
    string,
    NodeJS.Timeout
  >();

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

    const configuredRetrySeconds = this.configService.get<number | string>(
      'autopilot.iterativeReviewAssignmentRetrySeconds',
    );
    const parsedRetrySeconds = Number(configuredRetrySeconds);
    this.iterativeAssignmentRetryMs =
      Number.isFinite(parsedRetrySeconds) && parsedRetrySeconds >= 0
        ? parsedRetrySeconds * 1000
        : 30_000;
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
    const reviewers = await this.resourcesService.getReviewerResources(
      challenge.id,
      this.iterativeRoles,
    );

    if (reviewers.length !== 1) {
      this.logger.debug(
        `Skipping iterative reviewer added handling for challenge ${challenge.id}; expected the first reviewer but found ${reviewers.length}.`,
      );
      return;
    }

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

      const openRegistrationPhases = challenge.phases.filter(
        (phaseCandidate) =>
          phaseCandidate.isOpen &&
          phaseCandidate.name === REGISTRATION_PHASE_NAME,
      );

      for (const registrationPhase of openRegistrationPhases) {
        await this.schedulerService.advancePhase({
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: registrationPhase.id,
          phaseTypeName: registrationPhase.name,
          state: 'END',
          operator: AutopilotOperator.SYSTEM,
          projectStatus: challenge.status,
        });
      }
    } else {
      this.logger.log(
        `Iterative review failed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore}, passing ${passingScore}).`,
      );
      const lastSubmissionId =
        payload.submissionId ?? review.submissionId ?? undefined;
      await this.prepareNextIterativeReview(challenge.id, lastSubmissionId);
    }
  }

  private async processFirst2FinishSubmission(
    challenge: IChallenge,
    submissionId?: string,
  ): Promise<void> {
    if (!this.isFirst2FinishChallenge(challenge.type)) {
      return;
    }

    if (!isActiveStatus(challenge.status)) {
      this.logger.debug(
        `Skipping iterative review processing for challenge ${challenge.id}; status ${challenge.status ?? 'UNKNOWN'} is not active.`,
        {
          submissionId: submissionId ?? null,
        },
      );
      return;
    }

    const latestIterativePhase = this.getLatestIterativePhase(challenge);

    if (!latestIterativePhase) {
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

    const scorecardId = this.pickIterativeScorecard(challenge, latestIterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challenge.id}.`,
      );
      return;
    }

    let activePhase: IPhase | null =
      challenge.phases.find(
        (phase) => phase.name === ITERATIVE_REVIEW_PHASE_NAME && phase.isOpen,
      ) ?? null;

    if (activePhase) {
      const pendingReviews = await this.reviewService.getPendingReviewCount(
        activePhase.id,
        challenge.id,
      );

      if (pendingReviews > 0) {
        this.logger.debug(
          `Iterative review already in progress for challenge ${challenge.id}; deferring submission processing.`,
          {
            submissionId: submissionId ?? null,
            activePhaseId: activePhase.id,
            pendingReviews,
          },
        );
        return;
      }

      // Safety: if any non-completed review exists for this phase, do not close or reassign
      const existingPairs = await this.reviewService.getExistingReviewPairs(
        activePhase.id,
        challenge.id,
      );
      if (existingPairs.size > 0) {
        this.logger.debug(
          `Iterative review work detected for challenge ${challenge.id}; deferring.`,
          {
            submissionId: submissionId ?? null,
            activePhaseId: activePhase.id,
            existingPairs: existingPairs.size,
          },
        );
        return;
      }
    }

    if (!activePhase) {
      if (!submissionId) {
        const availableSubmissionIds =
          await this.reviewService.getAllSubmissionIdsOrdered(challenge.id);

        if (!availableSubmissionIds.length) {
          this.logger.debug(
            `Skipping iterative review phase creation for challenge ${challenge.id}; no submissions available for iterative review.`,
          );
          return;
        }
      }

      if (this.canReuseSeedIterativePhase(latestIterativePhase)) {
        activePhase = await this.reopenSeedIterativePhase(
          challenge,
          latestIterativePhase,
        );
      }

      if (!activePhase) {
        activePhase = await this.createNextIterativePhase(
          challenge,
          latestIterativePhase,
        );
      }

      if (!activePhase) {
        return;
      }
    }

    const assigned = await this.assignIterativeReviewToReviewers(
      challenge.id,
      activePhase,
      reviewers,
      scorecardId,
      submissionId,
    );

    if (!assigned) {
      this.logger.debug(
        `No additional submissions available for iterative review on challenge ${challenge.id}; closing phase ${activePhase.id}.`,
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
    this.scheduleIterativeAssignmentVerification(challenge.id);
  }

  private scheduleIterativeAssignmentVerification(challengeId: string): void {
    const existingTimer = this.iterativeAssignmentRetryTimers.get(challengeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const executeVerification = () => {
      this.iterativeAssignmentRetryTimers.delete(challengeId);
      void this.verifyIterativeAssignment(challengeId);
    };

    if (this.iterativeAssignmentRetryMs <= 0) {
      executeVerification();
      return;
    }

    const timer = setTimeout(executeVerification, this.iterativeAssignmentRetryMs);
    this.iterativeAssignmentRetryTimers.set(challengeId, timer);
  }

  private async verifyIterativeAssignment(challengeId: string): Promise<void> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.isFirst2FinishChallenge(challenge.type)) {
        return;
      }

      if (!isActiveStatus(challenge.status)) {
        return;
      }

      const activePhase =
        challenge.phases.find(
          (phase) =>
            phase.name === ITERATIVE_REVIEW_PHASE_NAME && phase.isOpen,
        ) ?? null;

      if (!activePhase) {
        return;
      }

      const pendingCount = await this.reviewService.getPendingReviewCount(
        activePhase.id,
        challengeId,
      );

      if (pendingCount > 0) {
        return;
      }

      const reviewers = await this.resourcesService.getReviewerResources(
        challengeId,
        this.iterativeRoles,
      );

      if (!reviewers.length) {
        return;
      }

      const scorecardId = this.pickIterativeScorecard(challenge, activePhase);
      if (!scorecardId) {
        return;
      }

      const assigned = await this.assignIterativeReviewToReviewers(
        challengeId,
        activePhase,
        reviewers,
        scorecardId,
      );

      if (!assigned) {
        this.logger.debug(
          `Iterative review assignment verification found no eligible submissions for challenge ${challengeId}.`,
          {
            phaseId: activePhase.id,
          },
        );
        return;
      }

      this.logger.log(
        `Recreated pending iterative review for challenge ${challengeId} after verification retry.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to verify iterative review assignment for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  private async assignNextIterativeReview(
    challengeId: string,
    phase: IPhase,
    resourceId: string,
    scorecardId: string,
    candidateSubmissionIds: string[],
    usedPairs: Set<string>,
  ): Promise<boolean> {
    for (const submissionId of candidateSubmissionIds) {
      if (!submissionId) {
        continue;
      }

      const key = `${resourceId}:${submissionId}`;
      if (usedPairs.has(key)) {
        continue;
      }

      try {
        const created = await this.reviewService.createPendingReview(
          submissionId,
          resourceId,
          phase.id,
          scorecardId,
          challengeId,
        );

        if (created) {
          usedPairs.add(key);
          this.logger.log(
            `Assigned iterative review for submission ${submissionId} to resource ${resourceId} on challenge ${challengeId}.`,
          );
          return true;
        }

        usedPairs.add(key);
      } catch (error) {
        if (this.isDuplicateReviewPairError(error)) {
          usedPairs.add(key);
          this.logger.debug(
            `Skipped duplicate iterative review assignment for submission ${submissionId} and resource ${resourceId} on challenge ${challengeId}.`,
          );
          continue;
        }

        throw error;
      }
    }

    return false;
  }

  private async prepareNextIterativeReview(
    challengeId: string,
    lastSubmissionId?: string,
  ): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (!isActiveStatus(challenge.status)) {
      return;
    }

    const latestIterativePhase = this.getLatestIterativePhase(challenge);

    if (!latestIterativePhase) {
      return;
    }

    if (latestIterativePhase.isOpen) {
      this.logger.debug(
        `Iterative review phase ${latestIterativePhase.id} already open for challenge ${challengeId}; awaiting additional submissions.`,
      );
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

    const submissionIds = await this.reviewService.getAllSubmissionIdsOrdered(
      challengeId,
    );

    const recentPairs = await this.reviewService.getExistingReviewPairs(
      latestIterativePhase.id,
      challengeId,
    );
    const reviewerHistoryPairs =
      await this.reviewService.getReviewerSubmissionPairs(challengeId);
    const exclusionPairs = new Set<string>([
      ...recentPairs,
      ...reviewerHistoryPairs,
    ]);

    const preferredSubmissionId = this.selectNextIterativeSubmission(
      reviewers,
      submissionIds,
      exclusionPairs,
      lastSubmissionId,
    );

    if (!preferredSubmissionId) {
      this.logger.debug(
        `No pending submissions available for next iterative review on challenge ${challengeId}; will wait for new submissions.`,
      );
      return;
    }

    const scorecardId = this.pickIterativeScorecard(
      challenge,
      latestIterativePhase,
    );

    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase on challenge ${challengeId}.`,
      );
      return;
    }

    let nextPhase: IPhase | null = null;

    if (this.canReuseSeedIterativePhase(latestIterativePhase)) {
      nextPhase = await this.reopenSeedIterativePhase(
        challenge,
        latestIterativePhase,
      );
    }

    if (!nextPhase) {
      nextPhase = await this.createNextIterativePhase(
        challenge,
        latestIterativePhase,
      );
    }

    if (!nextPhase) {
      return;
    }

    const assigned = await this.assignIterativeReviewToReviewers(
      challengeId,
      nextPhase,
      reviewers,
      scorecardId,
      preferredSubmissionId,
    );

    if (!assigned) {
      this.logger.debug(
        `Unable to assign next iterative review for challenge ${challengeId}; closing phase ${nextPhase.id}.`,
      );

      await this.schedulerService.advancePhase({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: nextPhase.id,
        phaseTypeName: nextPhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });
      return;
    }

    await this.scheduleIterativeReviewClosure(challenge, nextPhase);
    this.scheduleIterativeAssignmentVerification(challengeId);
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

  private getLatestIterativePhase(challenge: IChallenge): IPhase | null {
    const phases = challenge.phases?.filter(
      (phase) => phase.name === ITERATIVE_REVIEW_PHASE_NAME,
    );

    if (!phases?.length) {
      return null;
    }

    const sorted = [...phases].sort((a, b) => {
      return this.getPhaseStartTime(a) - this.getPhaseStartTime(b);
    });

    return sorted.at(-1) ?? null;
  }

  private canReuseSeedIterativePhase(phase: IPhase): boolean {
    return (
      !phase.isOpen &&
      !phase.actualStartDate &&
      !phase.actualEndDate
    );
  }

  private async reopenSeedIterativePhase(
    challenge: IChallenge,
    phase: IPhase,
  ): Promise<IPhase | null> {
    try {
      await this.schedulerService.advancePhase({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: phase.id,
        phaseTypeName: phase.name,
        state: 'START',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
      });

      const refreshed = await this.challengeApiService.getPhaseDetails(
        challenge.id,
        phase.id,
      );

      if (!refreshed?.isOpen) {
        this.logger.warn(
          `Failed to reopen seeded iterative review phase ${phase.id} for challenge ${challenge.id}; proceeding to create a new phase.`,
        );
        return null;
      }

      this.logger.log(
        `Reopened seeded iterative review phase ${phase.id} for challenge ${challenge.id}.`,
      );

      return refreshed;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to reopen seeded iterative review phase ${phase.id} on challenge ${challenge.id}: ${err.message}`,
        err.stack,
      );
      return null;
    }
  }

  private getPhaseStartTime(phase: IPhase): number {
    const reference = phase.actualStartDate ?? phase.scheduledStartDate;
    return new Date(reference).getTime();
  }

  private selectNextIterativeSubmission(
    reviewers: Array<{ id: string }>,
    submissionIds: string[],
    exclusionPairs: Set<string>,
    lastSubmissionId?: string,
  ): string | null {
    for (const submissionId of submissionIds) {
      if (submissionId === lastSubmissionId) {
        continue;
      }

      const alreadyReviewed = reviewers.some((reviewer) =>
        exclusionPairs.has(`${reviewer.id}:${submissionId}`),
      );

      if (!alreadyReviewed) {
        return submissionId;
      }
    }

    return null;
  }

  private async createNextIterativePhase(
    challenge: IChallenge,
    predecessor: IPhase,
  ): Promise<IPhase | null> {
    try {
      const durationSeconds = Math.max(
        Math.round(this.iterativeReviewDurationMs / 1000),
        predecessor.duration || 1,
      );

      return await this.challengeApiService.createIterativeReviewPhase(
        challenge.id,
        predecessor.id,
        predecessor.phaseId,
        predecessor.name,
        predecessor.description,
        durationSeconds,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to create next iterative review phase after ${predecessor.id} on challenge ${challenge.id}: ${err.message}`,
        err.stack,
      );
      return null;
    }
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

  private async assignIterativeReviewToReviewers(
    challengeId: string,
    phase: IPhase,
    reviewers: Array<{ id: string }>,
    scorecardId: string,
    preferredSubmissionId?: string,
  ): Promise<boolean> {
    const submissionIds =
      await this.reviewService.getAllSubmissionIdsOrdered(challengeId);

    const orderedIds = preferredSubmissionId
      ? [preferredSubmissionId, ...submissionIds]
      : submissionIds;

    const seen = new Set<string>();
    const candidateSubmissionIds = orderedIds.filter((id) => {
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });

    if (!candidateSubmissionIds.length) {
      return false;
    }

    const pendingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );
    const historicalPairs = await this.reviewService.getReviewerSubmissionPairs(
      challengeId,
    );
    const usedPairs = new Set<string>([...pendingPairs, ...historicalPairs]);

    for (const reviewer of reviewers) {
      const assigned = await this.assignNextIterativeReview(
        challengeId,
        phase,
        reviewer.id,
        scorecardId,
        candidateSubmissionIds,
        usedPairs,
      );

      if (assigned) {
        return true;
      }
    }

    return false;
  }

  private isDuplicateReviewPairError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: string; message?: string };
    const code = typeof candidate.code === 'string' ? candidate.code : '';

    if (code === 'P2002' || code === 'P2034' || code === '23505') {
      return true;
    }

    if (code.toUpperCase().includes('23505')) {
      return true;
    }

    const message = typeof candidate.message === 'string' ? candidate.message : '';

    return (
      message.includes('already exists') || message.includes('duplicate key')
    );
  }
}
