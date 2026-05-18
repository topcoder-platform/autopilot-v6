import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
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
  AI_SCREENING_PHASE_NAME,
  PHASE_ROLE_MAP,
  REGISTRATION_PHASE_NAME,
  isSubmissionPhaseName,
} from '../constants/review.constants';
import {
  describeChallengeType,
  isFirst2FinishChallenge as isSupportedChallengeType,
} from '../constants/challenge.constants';
import { isActiveStatus } from '../utils/config.utils';
import { selectScorecardId } from '../utils/reviewer.utils';
import { ChallengeCompletionService } from './challenge-completion.service';

@Injectable()
export class First2FinishService {
  private readonly logger = new Logger(First2FinishService.name);
  private readonly aiScreeningRestartCooldownMs = 30_000;
  private readonly iterativeRoles: string[];
  private readonly iterativeReviewDurationMs: number;
  private readonly iterativeAssignmentRetryMs: number;
  private readonly iterativeAssignmentRetryTimers = new Map<
    string,
    NodeJS.Timeout
  >();

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    @Inject(forwardRef(() => SchedulerService))
    private readonly schedulerService: SchedulerService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
    private readonly challengeCompletionService: ChallengeCompletionService,
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

  /**
   * Assigns iterative review work for an Iterative Review phase that has
   * already been opened by the scheduler or open-phase recovery.
   * @param challengeId Challenge containing the open Iterative Review phase.
   * @param phaseId Open Iterative Review phase that should receive work.
   * @returns Resolves when assignment has been attempted or skipped.
   * @throws Errors from challenge, resource, review, or scheduler services when
   * assignment prerequisites cannot be read or the pending review cannot be created.
   *
   * Used by phase-open reconciliation paths that need to repair a missing
   * pending review without invoking the broader submission processor. The broader
   * processor may restart AI Screening, close Iterative Review phases, or create
   * a successor phase, which is not safe from a phase-open callback.
   */
  async handleIterativePhaseOpened(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);

    if (!this.isFirst2FinishChallenge(challenge.type)) {
      return;
    }

    if (!isActiveStatus(challenge.status)) {
      return;
    }

    const phase = challenge.phases?.find(
      (candidate) =>
        candidate.id === phaseId &&
        candidate.name === ITERATIVE_REVIEW_PHASE_NAME,
    );

    if (!phase?.isOpen) {
      return;
    }

    const latestIterativePhase = this.getLatestIterativePhase(challenge);
    if (latestIterativePhase?.id !== phase.id) {
      this.logger.debug(
        `Skipping iterative phase-open assignment for stale phase ${phase.id} on challenge ${challengeId}; latest phase is ${latestIterativePhase?.id ?? 'unknown'}.`,
      );
      return;
    }

    const pendingReviews = await this.reviewService.getPendingReviewCount(
      phase.id,
      challengeId,
    );

    if (pendingReviews > 0) {
      return;
    }

    const existingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );

    if (existingPairs.size > 0) {
      return;
    }

    const reviewers = await this.resourcesService.getReviewerResources(
      challengeId,
      this.iterativeRoles,
    );

    if (!reviewers.length) {
      this.logger.warn(
        `Awaiting iterative reviewer assignment for challenge ${challengeId} before repairing open phase ${phase.id}.`,
      );
      return;
    }

    const scorecardId = this.pickIterativeScorecard(challenge, phase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase ${phase.id} on challenge ${challengeId}.`,
      );
      return;
    }

    const assigned = await this.assignIterativeReviewToReviewers(
      challengeId,
      phase,
      reviewers,
      scorecardId,
    );

    if (!assigned) {
      this.logger.debug(
        `No eligible submissions available for open iterative review phase ${phase.id} on challenge ${challengeId}; leaving phase open.`,
      );
      return;
    }

    await this.scheduleIterativeReviewClosure(challenge, phase);
    this.scheduleIterativeAssignmentVerification(challengeId);
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
      skipIterativePhaseRefresh: finalScore >= passingScore,
    });

    if (finalScore >= passingScore) {
      this.logger.log(
        `Iterative review passed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore} / passing ${passingScore}).`,
      );

      await this.closeOpenSubmissionAndRegistrationPhases(challenge);
      await this.completeFirst2FinishChallenge(challenge, payload);
    } else {
      this.logger.log(
        `Iterative review failed for submission ${payload.submissionId} on challenge ${challenge.id} (score ${finalScore}, passing ${passingScore}).`,
      );
      const lastSubmissionId =
        payload.submissionId ?? review.submissionId ?? undefined;
      await this.prepareNextIterativeReview(challenge.id, lastSubmissionId);
    }
  }

  private async completeFirst2FinishChallenge(
    challenge: IChallenge,
    payload: ReviewCompletedPayload,
  ): Promise<boolean> {
    return this.completeFirst2FinishChallengeForSubmitter(
      challenge,
      payload.submitterMemberId,
      payload.submitterHandle,
      'iterative-review-pass',
    );
  }

  /**
   * Completes a First2Finish challenge for a known passing submitter.
   * @param challenge Active challenge that should be completed.
   * @param submitterMemberId Member id associated with the winning submission.
   * @param fallbackHandle Handle supplied by the event or lookup source.
   * @param reason Audit reason passed to the completion service.
   * @returns True when completion was invoked; false when required submitter
   * data was missing or the challenge is no longer active.
   * @throws Error when challenge completion or downstream synchronous work fails.
   *
   * Used by both the primary review-completed Kafka path and the phase-close
   * reconciliation path.
   */
  private async completeFirst2FinishChallengeForSubmitter(
    challenge: IChallenge,
    submitterMemberId: string | number | null | undefined,
    fallbackHandle: string | null | undefined,
    reason: string,
  ): Promise<boolean> {
    if (!isActiveStatus(challenge.status)) {
      this.logger.debug(
        `Skipping completion for challenge ${challenge.id}; status ${challenge.status ?? 'UNKNOWN'} is not ACTIVE.`,
      );
      return false;
    }

    const memberId = String(submitterMemberId ?? '').trim();
    const numericMemberId = Number(memberId);

    if (!memberId || !Number.isFinite(numericMemberId)) {
      this.logger.warn(
        `Unable to complete challenge ${challenge.id} after passing iterative review; submitterMemberId is invalid (${submitterMemberId ?? 'missing'}).`,
      );
      return false;
    }

    let handle = fallbackHandle?.trim();
    try {
      const handleMap = await this.resourcesService.getMemberHandleMap(
        challenge.id,
        [memberId],
      );
      handle = handleMap.get(memberId) ?? handle;
    } catch (error) {
      const err = error as Error;
      this.logger.warn(
        `Failed to resolve handle for member ${memberId} on challenge ${challenge.id}; using provided payload handle.`,
        err.stack,
      );
    }

    await this.challengeCompletionService.completeChallengeWithWinners(
      challenge.id,
      [
        {
          userId: numericMemberId,
          handle: handle && handle.length ? handle : memberId,
          placement: 1,
        },
      ],
      {
        reason,
      },
    );
    return true;
  }

  /**
   * Closes any open submission and registration phases before completing after a
   * passing iterative review.
   * @param challenge Challenge snapshot whose open phases should be ended.
   * @returns Promise resolved after all relevant phase close requests finish.
   * @throws Error when a phase close operation fails.
   *
   * Used by both primary and reconciled First2Finish completion paths so the
   * challenge has no lingering open phases after a passing review.
   */
  private async closeOpenSubmissionAndRegistrationPhases(
    challenge: IChallenge,
  ): Promise<void> {
    const submissionPhase = challenge.phases.find(
      (phase) => isSubmissionPhaseName(phase.name) && phase.isOpen,
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
  }

  async handleIterativePhaseClosed(challengeId: string): Promise<void> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!isActiveStatus(challenge.status)) {
        return;
      }

      const latestIterativePhase = this.getLatestIterativePhase(challenge);

      if (latestIterativePhase && !latestIterativePhase.isOpen) {
        const handled = await this.completeFromPassingIterativeReview(
          challenge,
          latestIterativePhase,
        );

        if (handled) {
          return;
        }
      }

      await this.prepareNextIterativeReview(challengeId);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to refresh iterative review submissions for challenge ${challengeId} after phase closure: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Completes an active challenge when a closed iterative phase already contains
   * a passing completed review.
   * @param challenge Active First2Finish challenge being reconciled.
   * @param phase Closed Iterative Review phase to inspect.
   * @returns True when a passing review was found and handled, even if
   * completion could not run because submitter data was incomplete.
   * @throws Error when review lookup, phase closure, or challenge completion
   * operations fail.
   *
   * Used as a backup when the review-completed Kafka event was missed and the
   * scheduler later closes the iterative phase.
   */
  private async completeFromPassingIterativeReview(
    challenge: IChallenge,
    phase: IPhase,
  ): Promise<boolean> {
    const passingReview =
      await this.reviewService.getLatestPassingReviewForPhase(
        challenge.id,
        phase.id,
      );

    if (!passingReview) {
      return false;
    }

    this.logger.log(
      `Reconciling passed iterative review ${passingReview.id} for submission ${passingReview.submissionId} on challenge ${challenge.id} (score ${passingReview.score} / passing ${passingReview.passingScore}).`,
    );

    await this.closeOpenSubmissionAndRegistrationPhases(challenge);
    await this.completeFirst2FinishChallengeForSubmitter(
      challenge,
      passingReview.submitterMemberId,
      null,
      'iterative-review-pass-reconciled',
    );

    return true;
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

    // If an AI Screening phase exists, start or wait for it — unless this submission
    // already has a completed AI review decision, in which case screening can be skipped.
    const aiScreeningPhase = (challenge.phases ?? []).find(
      (p) => p.name === AI_SCREENING_PHASE_NAME,
    );
    let aiDecision: { status: string } | undefined;
    if (aiScreeningPhase) {
      aiDecision =
        submissionId != null
          ? await this.reviewService.hasAiDecisionForSubmission(
              challenge.id,
              submissionId,
            )
          : undefined;

      if (aiDecision) {
        this.logger.debug(
          `Submission ${submissionId} already has an AI review decision (${aiDecision.status}) for challenge ${challenge.id}; skipping AI Screening gate.`,
        );
      } else if (this.shouldRestartAiScreeningPhase(aiScreeningPhase)) {
        this.logger.debug(
          `Starting AI Screening phase ${aiScreeningPhase.id} for challenge ${challenge.id} on submission arrival.`,
          { submissionId: submissionId ?? null },
        );
        try {
          await this.schedulerService.advancePhase({
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: aiScreeningPhase.id,
            phaseTypeName: aiScreeningPhase.name,
            state: 'START',
            operator: AutopilotOperator.SYSTEM,
            projectStatus: challenge.status,
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to start AI Screening phase ${aiScreeningPhase.id} for challenge ${challenge.id}: ${err.message}`,
            err.stack,
          );
        }
        return;
      } else if (!aiScreeningPhase.isOpen) {
        this.logger.debug(
          `Skipping AI Screening restart for challenge ${challenge.id}; phase ${aiScreeningPhase.id} closed too recently, proceeding with iterative processing.`,
          { submissionId: submissionId ?? null },
        );
      } else {
        this.logger.debug(
          `Awaiting AI Screening completion for challenge ${challenge.id} before processing iterative review.`,
          { submissionId: submissionId ?? null },
        );
        return;
      }
    }

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

    const scorecardId = this.pickIterativeScorecard(
      challenge,
      latestIterativePhase,
    );
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
      const currentPhase = activePhase;

      const pendingReviews = await this.reviewService.getPendingReviewCount(
        currentPhase.id,
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
        currentPhase.id,
        challenge.id,
      );
      if (existingPairs.size > 0) {
        this.logger.debug(
          `Iterative review work detected for challenge ${challenge.id}; deferring.`,
          {
            submissionId: submissionId ?? null,
            activePhaseId: currentPhase.id,
            existingPairs: existingPairs.size,
          },
        );
        return;
      }

      const completedIterativePhases = challenge.phases.filter(
        (phaseCandidate) =>
          phaseCandidate.id !== currentPhase.id &&
          phaseCandidate.name === ITERATIVE_REVIEW_PHASE_NAME &&
          !phaseCandidate.isOpen &&
          !!phaseCandidate.actualEndDate,
      );

      if (completedIterativePhases.length > 0) {
        try {
          await this.schedulerService.advancePhase({
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: currentPhase.id,
            phaseTypeName: currentPhase.name,
            state: 'END',
            operator: AutopilotOperator.SYSTEM,
            projectStatus: challenge.status,
          });

          this.logger.debug(
            `Closed iterative review phase ${currentPhase.id} for challenge ${challenge.id} before assigning next submission.`,
          );
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to close iterative review phase ${currentPhase.id} before next assignment on challenge ${challenge.id}: ${err.message}`,
            err.stack,
          );
          return;
        }

        activePhase = null;
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

    // do not create & attach reviews for failed ai decissions.
    // leave the iterative review phase open so copilot/reviewer can unlock submission
    if (aiDecision && aiDecision.status.toUpperCase() !== 'PASSED') {
      this.logger.log(
        `Skipping iterative review creation for submission ${submissionId ?? 'latest'} on challenge ${challenge.id}; AI decision is ${aiDecision.status} (requires PASSED).`,
      );
      return;
    }

    const assigned = await this.assignIterativeReviewToReviewers(
      challenge.id,
      activePhase,
      reviewers,
      scorecardId,
      submissionId,
    );

    if (!assigned) {
      const submissionSnapshot =
        await this.reviewService.getAllSubmissionIdsOrdered(challenge.id);

      if (!submissionSnapshot.length) {
        this.logger.debug(
          `No submissions available yet for iterative review on challenge ${challenge.id}; keeping phase ${activePhase.id} open.`,
          {
            submissionId: submissionId ?? null,
            phaseId: activePhase.id,
          },
        );
        return;
      }

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

    const timer = setTimeout(
      executeVerification,
      this.iterativeAssignmentRetryMs,
    );
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
          (phase) => phase.name === ITERATIVE_REVIEW_PHASE_NAME && phase.isOpen,
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
        const { created } = await this.reviewService.createPendingReview(
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

    const submissionIds =
      await this.reviewService.getAllSubmissionIdsOrdered(challengeId);

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

    // If an AI Screening phase exists and the next submission doesn't already have
    // a completed AI review decision, (re)start screening and wait for it to finish.
    const aiScreeningPhase = (challenge.phases ?? []).find(
      (p) => p.name === AI_SCREENING_PHASE_NAME,
    );
    let aiDecision: { status: string } | undefined;
    if (aiScreeningPhase) {
      aiDecision = await this.reviewService.hasAiDecisionForSubmission(
        challengeId,
        preferredSubmissionId,
      );

      if (aiDecision) {
        this.logger.debug(
          `Submission ${preferredSubmissionId} already has an AI review decision (${aiDecision.status}) for challenge ${challengeId}; skipping AI Screening gate.`,
        );
      } else if (this.shouldRestartAiScreeningPhase(aiScreeningPhase)) {
        this.logger.debug(
          `Starting AI Screening phase ${aiScreeningPhase.id} for challenge ${challengeId} before next iterative review (submission ${preferredSubmissionId}).`,
        );
        try {
          await this.schedulerService.advancePhase({
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: aiScreeningPhase.id,
            phaseTypeName: aiScreeningPhase.name,
            state: 'START',
            operator: AutopilotOperator.SYSTEM,
            projectStatus: challenge.status,
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to start AI Screening phase ${aiScreeningPhase.id} for challenge ${challengeId}: ${err.message}`,
            err.stack,
          );
        }
        return;
      } else if (!aiScreeningPhase.isOpen) {
        this.logger.debug(
          `Skipping AI Screening restart for challenge ${challengeId}; phase ${aiScreeningPhase.id} closed too recently for submission ${preferredSubmissionId}.`,
        );
        return;
      } else {
        this.logger.debug(
          `Awaiting AI Screening completion for challenge ${challengeId} before next iterative review (submission ${preferredSubmissionId}).`,
        );
        return;
      }
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

    // do not create & attach reviews for failed ai decissions.
    // leave the iterative review phase open so copilot/reviewer can unlock submission
    if (aiDecision && aiDecision.status.toUpperCase() !== 'PASSED') {
      this.logger.log(
        `Skipping next iterative review preparation for submission ${preferredSubmissionId} on challenge ${challengeId}; AI decision is ${aiDecision.status} (requires PASSED).`,
      );
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
    // Prefer configured scorecard(s) on the challenge for the Iterative Review phase
    const selected = selectScorecardId(
      challenge.reviewers ?? [],
      () => null,
      () => null,
      phase.phaseId,
    );

    if (selected) {
      return selected;
    }

    // Fallback: use a default iterative review scorecard if provided via config
    const fallback = this.configService.get<string | null>(
      'autopilot.iterativeReviewScorecardId',
    );

    if (fallback && typeof fallback === 'string' && fallback.trim().length) {
      this.logger.warn(
        `Using fallback iterative review scorecard ${fallback} for challenge ${challenge.id} (no phase-specific scorecard configured).`,
      );
      return fallback.trim();
    }

    return null;
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
    return !phase.isOpen && !phase.actualStartDate && !phase.actualEndDate;
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

  private shouldRestartAiScreeningPhase(phase: IPhase): boolean {
    if (phase.isOpen) {
      return false;
    }

    if (!phase.actualEndDate) {
      return true;
    }

    const closedAt = new Date(phase.actualEndDate).getTime();

    if (!Number.isFinite(closedAt)) {
      return true;
    }

    return Date.now() - closedAt > this.aiScreeningRestartCooldownMs;
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

    const eligibleSubmissionIds =
      await this.filterAiFailedIterativeSubmissionIds(
        challengeId,
        candidateSubmissionIds,
      );

    if (!eligibleSubmissionIds.length) {
      return false;
    }

    const pendingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );
    const historicalPairs =
      await this.reviewService.getReviewerSubmissionPairs(challengeId);
    const usedPairs = new Set<string>([...pendingPairs, ...historicalPairs]);

    for (const reviewer of reviewers) {
      const assigned = await this.assignNextIterativeReview(
        challengeId,
        phase,
        reviewer.id,
        scorecardId,
        eligibleSubmissionIds,
        usedPairs,
      );

      if (assigned) {
        return true;
      }
    }

    return false;
  }

  private async filterAiFailedIterativeSubmissionIds(
    challengeId: string,
    submissionIds: string[],
  ): Promise<string[]> {
    if (!submissionIds.length) {
      return submissionIds;
    }

    try {
      const aiFailedIds =
        await this.reviewService.getAiFailedDecisionSubmissionIds(
          challengeId,
          submissionIds,
        );

      if (!aiFailedIds.size) {
        return submissionIds;
      }

      const filteredSubmissionIds = submissionIds.filter(
        (submissionId) => !aiFailedIds.has(submissionId),
      );

      this.logger.log(
        `Excluded ${submissionIds.length - filteredSubmissionIds.length} iterative review submission(s) for challenge ${challengeId} due to failed AI decisions.`,
      );

      return filteredSubmissionIds;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to filter iterative review submissions by AI decision for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );

      return submissionIds;
    }
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

    const message =
      typeof candidate.message === 'string' ? candidate.message : '';

    return (
      message.includes('already exists') || message.includes('duplicate key')
    );
  }
}
