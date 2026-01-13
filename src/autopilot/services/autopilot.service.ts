import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { PhaseReviewService } from './phase-review.service';
import { PhaseScheduleManager } from './phase-schedule-manager.service';
import { ResourceEventHandler } from './resource-event-handler.service';
import { First2FinishService } from './first2finish.service';
import {
  PhaseTransitionPayload,
  ChallengeUpdatePayload,
  CommandPayload,
  AutopilotOperator,
  SubmissionAggregatePayload,
  ResourceEventPayload,
  ReviewCompletedPayload,
  AppealRespondedPayload,
  First2FinishSubmissionPayload,
  TopgearSubmissionPayload,
} from '../interfaces/autopilot.interface';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { AUTOPILOT_COMMANDS } from '../../common/constants/commands.constants';
import {
  DEFAULT_APPEALS_PHASE_NAMES,
  DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
  ITERATIVE_REVIEW_PHASE_NAME,
  isPostMortemPhaseName,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
  PHASE_ROLE_MAP,
} from '../constants/review.constants';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  getNormalizedStringArray,
  isActiveStatus,
} from '../utils/config.utils';
import { selectScorecardId } from '../utils/reviewer.utils';
const SUBMISSION_NOTIFICATION_CREATE_TOPIC = 'submission.notification.create';

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  private readonly appealsPhaseNames: Set<string>;
  private readonly appealsResponsePhaseNames: Set<string>;

  constructor(
    private readonly phaseScheduleManager: PhaseScheduleManager,
    private readonly resourceEventHandler: ResourceEventHandler,
    private readonly first2FinishService: First2FinishService,
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly configService: ConfigService,
  ) {
    this.appealsPhaseNames = new Set(
      getNormalizedStringArray(
        this.configService.get('autopilot.appealsPhaseNames'),
        [...Array.from(DEFAULT_APPEALS_PHASE_NAMES)],
      ),
    );
    this.appealsResponsePhaseNames = new Set(
      getNormalizedStringArray(
        this.configService.get('autopilot.appealsResponsePhaseNames'),
        [...Array.from(DEFAULT_APPEALS_RESPONSE_PHASE_NAMES)],
      ),
    );
  }

  async schedulePhaseTransition(
    phaseData: PhaseTransitionPayload,
  ): Promise<string> {
    return this.phaseScheduleManager.schedulePhaseTransition(phaseData);
  }

  async cancelPhaseTransition(
    challengeId: string,
    phaseId: string,
  ): Promise<boolean> {
    return this.phaseScheduleManager.cancelPhaseTransition(
      challengeId,
      phaseId,
    );
  }

  async reschedulePhaseTransition(
    challengeId: string,
    newPhaseData: PhaseTransitionPayload,
  ): Promise<string> {
    return this.phaseScheduleManager.reschedulePhaseTransition(
      challengeId,
      newPhaseData,
    );
  }

  handlePhaseTransition(message: PhaseTransitionPayload): void {
    void this.phaseScheduleManager.handlePhaseTransition(message);
  }

  async handleNewChallenge(challenge: ChallengeUpdatePayload): Promise<void> {
    await this.phaseScheduleManager.handleNewChallenge(challenge);
  }

  async handleChallengeUpdate(message: ChallengeUpdatePayload): Promise<void> {
    await this.phaseScheduleManager.handleChallengeUpdate(message);
  }

  async handleSubmissionNotificationAggregate(
    payload: SubmissionAggregatePayload,
  ): Promise<void> {
    const { id: submissionId } = payload;
    const challengeId = payload.v5ChallengeId;

    if (payload.originalTopic !== SUBMISSION_NOTIFICATION_CREATE_TOPIC) {
      this.logger.debug(
        'Ignoring submission aggregate message with non-create original topic',
        {
          submissionId,
          originalTopic: payload.originalTopic,
        },
      );
      return;
    }

    if (!challengeId) {
      this.logger.warn(
        'Submission aggregate message missing v5ChallengeId; unable to process',
        { submissionId },
      );
      return;
    }

    try {
      await this.first2FinishService.handleSubmissionByChallengeId(
        challengeId,
        submissionId,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed processing submission aggregate for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }

    // Ensure screening/review records exist when a submission arrives during an open phase
    try {
      const challenge = await this.challengeApiService.getChallengeById(
        challengeId,
      );

      if (!isActiveStatus(challenge.status)) {
        return;
      }

      const submissionType = (payload.type || '').toString().trim().toUpperCase();

      // Map submission types to relevant open phases to sync
      const targetPhaseNames = new Set<string>();
      if (submissionType === 'CHECKPOINT_SUBMISSION') {
        targetPhaseNames.add('Checkpoint Screening');
      } else if (submissionType === 'CONTEST_SUBMISSION' || !submissionType) {
        // Fallback: standard contest submission or unspecified type
        targetPhaseNames.add('Screening');
      }

      if (!targetPhaseNames.size) {
        return;
      }

      const openTargets = (challenge.phases ?? []).filter(
        (p) => p.isOpen && (SCREENING_PHASE_NAMES.has(p.name) || REVIEW_PHASE_NAMES.has(p.name)) && targetPhaseNames.has(p.name),
      );

      for (const phase of openTargets) {
        try {
          await this.phaseReviewService.handlePhaseOpened(challengeId, phase.id);
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to synchronize pending reviews for challenge ${challengeId}, phase ${phase.id} on submission ${submissionId}: ${err.message}`,
            err.stack,
          );
        }
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to synchronize review records after submission for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleResourceCreated(payload: ResourceEventPayload): Promise<void> {
    await this.resourceEventHandler.handleResourceCreated(payload);
  }

  async handleResourceDeleted(payload: ResourceEventPayload): Promise<void> {
    await this.resourceEventHandler.handleResourceDeleted(payload);
  }

  async handleReviewCompleted(payload: ReviewCompletedPayload): Promise<void> {
    const { challengeId, reviewId } = payload;

    try {
      const review = await this.reviewService.getReviewById(reviewId);
      if (!review) {
        this.logger.warn(
          `Review ${reviewId} not found when handling completion for challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!isActiveStatus(challenge.status)) {
        return;
      }

      const candidatePhaseIds = new Set<string>();
      if (review.phaseId) {
        candidatePhaseIds.add(review.phaseId);
      }
      if (payload.phaseId) {
        candidatePhaseIds.add(payload.phaseId);
      }

      if (!candidatePhaseIds.size) {
        this.logger.warn(
          `Review ${reviewId} does not provide a phase reference and payload is missing phaseId for challenge ${challengeId}.`,
        );
        return;
      }

      const phase = challenge.phases.find((phaseCandidate) => {
        if (candidatePhaseIds.has(phaseCandidate.id)) {
          return true;
        }
        if (phaseCandidate.phaseId) {
          return candidatePhaseIds.has(phaseCandidate.phaseId);
        }
        return false;
      });
      if (!phase) {
        this.logger.warn(
          `Unable to resolve phase for review ${reviewId} on challenge ${challengeId}. Candidates: ${Array.from(candidatePhaseIds).join(', ')}.`,
        );
        return;
      }

      if (!phase.isOpen) {
        this.logger.debug(
          `Phase ${phase.id} already closed for challenge ${challengeId}; ignoring review completion event.`,
        );
        return;
      }

      if (isPostMortemPhaseName(phase.name)) {
        const pendingPostMortemReviews =
          await this.reviewService.getPendingReviewCount(phase.id, challengeId);

        if (pendingPostMortemReviews > 0) {
          this.logger.debug(
            `Post-mortem phase ${phase.id} on challenge ${challengeId} still has ${pendingPostMortemReviews} pending review(s).`,
          );
          return;
        }

        this.logger.log(
          `All post-mortem reviews submitted for phase ${phase.id} on challenge ${challengeId}. Closing phase.`,
        );

        await this.schedulerService.advancePhase({
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          state: 'END',
          operator: AutopilotOperator.SYSTEM,
          projectStatus: challenge.status,
        });
        return;
      }

      if (phase.name === ITERATIVE_REVIEW_PHASE_NAME) {
        await this.first2FinishService.handleIterativeReviewCompletion(
          challenge,
          phase,
          review,
          payload,
        );
        return;
      }

      // Approval: compare against minimum passing score and create a follow-up Approval phase if it fails
      if (APPROVAL_PHASE_NAMES.has(phase.name)) {
        const scorecardId = review.scorecardId ?? payload.scorecardId ?? null;
        const passingScore =
          await this.reviewService.getScorecardPassingScore(scorecardId);

        const normalizedScore = (() => {
          if (typeof review.score === 'number') {
            return review.score;
          }
          const numeric = Number(review.score ?? payload.initialScore ?? 0);
          if (Number.isFinite(numeric)) {
            return numeric;
          }
          const fallback = Number(payload.initialScore ?? 0);
          return Number.isFinite(fallback) ? fallback : 0;
        })();

        const reviewPassed = normalizedScore >= passingScore;

        await this.schedulerService.advancePhase({
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          state: 'END',
          operator: AutopilotOperator.SYSTEM,
          projectStatus: challenge.status,
          preventFinalization: !reviewPassed,
        });

        if (reviewPassed) {
          this.logger.log(
            `Approval review passed for challenge ${challenge.id} (score ${normalizedScore} / passing ${passingScore}).`,
          );
          return;
        }

        this.logger.log(
          `Approval review failed for challenge ${challenge.id} (score ${normalizedScore} / passing ${passingScore}). Creating another Approval phase.`,
        );

        if (!phase.phaseId) {
          this.logger.error(
            `Cannot create follow-up Approval phase for challenge ${challenge.id}; missing phase template ID on phase ${phase.id}.`,
          );
          return;
        }

        try {
          const nextApproval = await this.challengeApiService.createApprovalPhase(
            challenge.id,
            phase.id,
            phase.phaseId,
            phase.name,
            phase.description ?? null,
            Math.max(phase.duration || 0, 1),
          );

          await this.createFollowUpApprovalReviews(
            challenge,
            nextApproval,
            review,
            payload,
          );

          await this.phaseReviewService.handlePhaseOpened(
            challenge.id,
            nextApproval.id,
          );
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to create follow-up Approval phase for challenge ${challenge.id}: ${err.message}`,
            err.stack,
          );
        }
        return;
      }

      if (!REVIEW_PHASE_NAMES.has(phase.name) && !SCREENING_PHASE_NAMES.has(phase.name)) {
        return;
      }

      const pendingReviews = await this.reviewService.getPendingReviewCount(
        phase.id,
        challengeId,
      );

      if (pendingReviews > 0) {
        this.logger.debug(
          `Review phase ${phase.id} for challenge ${challengeId} still has ${pendingReviews} review(s) in progress.`,
        );
        return;
      }

      this.logger.log(
        `All reviews completed for phase ${phase.id} on challenge ${challengeId}. Closing ${
          SCREENING_PHASE_NAMES.has(phase.name) ? 'Screening' : 'Review'
        } phase early.`,
      );

      await this.schedulerService.advancePhase({
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: phase.id,
        phaseTypeName: phase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
        skipReviewCompletionCheck: true,
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle review completion for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  private async createFollowUpApprovalReviews(
    challenge: IChallenge,
    nextPhase: IPhase,
    review: {
      submissionId: string | null;
      scorecardId: string | null;
      resourceId: string;
    },
    payload: ReviewCompletedPayload,
  ): Promise<void> {
    const submissionId = review.submissionId ?? payload.submissionId ?? null;

    if (!submissionId) {
      this.logger.warn(
        `Unable to assign follow-up approval review for challenge ${challenge.id}; submissionId missing.`,
      );
      return;
    }

    let scorecardId =
      review.scorecardId ??
      payload.scorecardId ??
      selectScorecardId(
        challenge.reviewers ?? [],
        () =>
          this.logger.warn(
            `Missing scorecard configuration for follow-up Approval phase ${nextPhase.id} on challenge ${challenge.id}.`,
          ),
        (choices) =>
          this.logger.warn(
            `Multiple scorecards ${choices.join(', ')} detected for follow-up Approval phase ${nextPhase.id} on challenge ${challenge.id}; defaulting to ${choices[0]}.`,
          ),
        nextPhase.phaseId ?? undefined,
      );

    if (!scorecardId) {
      return;
    }

    let approverResources: Array<{ id: string }> = [];
    const roleNames = PHASE_ROLE_MAP[nextPhase.name] ?? ['Approver'];

    try {
      approverResources = await this.resourcesService.getReviewerResources(
        challenge.id,
        roleNames,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to load approver resources for follow-up Approval phase ${nextPhase.id} on challenge ${challenge.id}: ${err.message}`,
        err.stack,
      );
      return;
    }

    const resourceMap = new Map<string, { id: string }>();
    for (const resource of approverResources) {
      if (resource?.id) {
        resourceMap.set(resource.id, { id: resource.id });
      }
    }

    if (review?.resourceId) {
      resourceMap.set(review.resourceId, { id: review.resourceId });
    }
    if (payload.reviewerResourceId) {
      resourceMap.set(payload.reviewerResourceId, {
        id: payload.reviewerResourceId,
      });
    }

    if (!resourceMap.size) {
      this.logger.warn(
        `Unable to assign follow-up approval review for challenge ${challenge.id}; no approver resources found.`,
      );
      return;
    }

    let createdCount = 0;
    for (const resource of resourceMap.values()) {
      try {
        const created = await this.reviewService.createPendingReview(
          submissionId,
          resource.id,
          nextPhase.id,
          scorecardId,
          challenge.id,
        );
        if (created) {
          createdCount += 1;
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed to create follow-up approval review for challenge ${challenge.id}, phase ${nextPhase.id}, resource ${resource.id}: ${err.message}`,
          err.stack,
        );
      }
    }

    if (createdCount > 0) {
      this.logger.log(
        `Created ${createdCount} follow-up approval review(s) for challenge ${challenge.id}, phase ${nextPhase.id}, submission ${submissionId}.`,
      );
    } else {
      this.logger.warn(
        `No follow-up approval reviews created for challenge ${challenge.id}, phase ${nextPhase.id}; a pending review may already exist.`,
      );
    }
  }

  async handleAppealResponded(payload: AppealRespondedPayload): Promise<void> {
    const { challengeId } = payload;

    if (!challengeId) {
      this.logger.warn('Appeal responded event missing challengeId.', payload);
      return;
    }

    try {
      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!isActiveStatus(challenge.status)) {
        this.logger.debug(
          `Skipping appeal responded handling for challenge ${challengeId} with status ${challenge.status}.`,
        );
        return;
      }

      const pendingAppeals =
        await this.reviewService.getPendingAppealCount(challengeId);

      if (pendingAppeals > 0) {
        this.logger.debug(
          `Appeal responded processed for challenge ${challengeId}, but ${pendingAppeals} appeal(s) still pending response.`,
        );
        return;
      }

      const phasesToClose =
        challenge.phases?.filter(
          (phase) =>
            phase.isOpen &&
            (this.appealsResponsePhaseNames.has(phase.name) ||
              this.appealsPhaseNames.has(phase.name)),
        ) ?? [];

      if (!phasesToClose.length) {
        this.logger.debug(
          `No open appeals or appeals response phases to close for challenge ${challengeId}.`,
        );
        return;
      }

      for (const phase of phasesToClose) {
        try {
          await this.schedulerService.advancePhase({
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: phase.id,
            phaseTypeName: phase.name,
            state: 'END',
            operator: AutopilotOperator.SYSTEM,
            projectStatus: challenge.status,
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to close phase ${phase.id} (${phase.name}) on challenge ${challengeId} after appeals resolved: ${err.message}`,
            err.stack,
          );
        }
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle appeal responded event for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleFirst2FinishSubmission(
    payload: First2FinishSubmissionPayload,
  ): Promise<void> {
    await this.handleRapidSubmission(payload, 'First2Finish');
  }

  async handleTopgearSubmission(
    payload: TopgearSubmissionPayload,
  ): Promise<void> {
    await this.handleRapidSubmission(payload, 'Topgear Task');
  }

  private async handleRapidSubmission(
    payload: First2FinishSubmissionPayload,
    challengeLabel: string,
  ): Promise<void> {
    try {
      await this.first2FinishService.handleSubmissionByChallengeId(
        payload.challengeId,
        payload.submissionId,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle ${challengeLabel} submission for challenge ${payload.challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleCommand(message: CommandPayload): Promise<void> {
    const { command, operator, projectId, date, phaseId } = message;

    this.logger.log(`[COMMAND RECEIVED] ${command} from ${operator}`);

    try {
      switch (command.toLowerCase()) {
        case AUTOPILOT_COMMANDS.CANCEL_SCHEDULE:
          if (!projectId) {
            this.logger.warn(
              `${AUTOPILOT_COMMANDS.CANCEL_SCHEDULE}: missing projectId`,
            );
            return;
          }

          if (phaseId) {
            const challengeId = message.challengeId;
            if (!challengeId) {
              this.logger.warn(
                `${AUTOPILOT_COMMANDS.CANCEL_SCHEDULE}: missing challengeId for phase ${phaseId}`,
              );
              return;
            }
            await this.phaseScheduleManager.cancelPhaseTransition(
              challengeId,
              phaseId,
            );
          } else {
            const challengeId = message.challengeId;
            if (!challengeId) {
              this.logger.warn(
                `${AUTOPILOT_COMMANDS.CANCEL_SCHEDULE}: missing challengeId`,
              );
              return;
            }
            await this.phaseScheduleManager.cancelAllPhasesForChallenge(
              challengeId,
            );
          }
          break;

        case AUTOPILOT_COMMANDS.RESCHEDULE_PHASE: {
          const challengeId = message.challengeId;
          if (!challengeId || !phaseId || !date) {
            this.logger.warn(
              `${AUTOPILOT_COMMANDS.RESCHEDULE_PHASE}: missing required data (challengeId, phaseId, or date)`,
            );
            return;
          }

          await this.handleRescheduleCommand({
            challengeId,
            phaseId,
            operator,
            date,
          });
          break;
        }

        default:
          this.logger.warn(`Unknown command received: ${command}`);
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Error handling command: ${err.message}`, err.stack);
    }
  }

  private async handleRescheduleCommand(
    params: Required<
      Pick<CommandPayload, 'challengeId' | 'phaseId' | 'date'>
    > & {
      operator: CommandPayload['operator'];
    },
  ): Promise<void> {
    const { challengeId, phaseId, date, operator } = params;

    try {
      const challengeDetails =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!challengeDetails) {
        this.logger.error(
          `Could not find challenge with ID ${challengeId} to reschedule.`,
        );
        return;
      }

      if (!isActiveStatus(challengeDetails.status)) {
        this.logger.log(
          `${AUTOPILOT_COMMANDS.RESCHEDULE_PHASE}: ignoring challenge ${challengeId} with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
        );
        return;
      }

      const phaseTypeName = await this.challengeApiService.getPhaseTypeName(
        challengeDetails.id,
        phaseId,
      );

      const payload: PhaseTransitionPayload = {
        projectId: challengeDetails.projectId,
        phaseId,
        challengeId: challengeDetails.id,
        phaseTypeName,
        operator,
        state: 'END',
        projectStatus: challengeDetails.status,
        date,
      };

      await this.phaseScheduleManager.reschedulePhaseTransition(
        challengeDetails.id,
        payload,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error in reschedule_phase command: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  

  async openAndScheduleNextPhases(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): Promise<void> {
    await this.phaseScheduleManager.processPhaseChain(
      challengeId,
      projectId,
      projectStatus,
      nextPhases,
    );
  }

  getActiveSchedules(): Map<string, string> {
    return this.phaseScheduleManager.getActiveSchedulesSnapshot();
  }

  getAllScheduledTransitions(): {
    jobIds: string[];
    activeSchedules: Map<string, string>;
  } {
    return {
      jobIds: this.schedulerService.getAllScheduledTransitions(),
      activeSchedules: this.getActiveSchedules(),
    };
  }

  getScheduledTransitionsDetails(): {
    totalScheduled: number;
    byChallenge: Record<string, string[]>;
    scheduledJobs: Map<string, PhaseTransitionPayload>;
  } {
    const activeSchedules = this.getActiveSchedules();
    const scheduledJobs =
      this.schedulerService.getAllScheduledTransitionsWithData();
    const byChallenge: Record<string, string[]> = {};

    for (const [phaseKey] of activeSchedules) {
      const [challengeId] = phaseKey.split(':');
      if (!byChallenge[challengeId]) {
        byChallenge[challengeId] = [];
      }
      byChallenge[challengeId].push(phaseKey);
    }

    return {
      totalScheduled: activeSchedules.size,
      byChallenge,
      scheduledJobs,
    };
  }
}
