import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
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
} from '../interfaces/autopilot.interface';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { IPhase } from '../../challenge/interfaces/challenge.interface';
import { AUTOPILOT_COMMANDS } from '../../common/constants/commands.constants';
import {
  DEFAULT_APPEALS_PHASE_NAMES,
  DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
  ITERATIVE_REVIEW_PHASE_NAME,
  REVIEW_PHASE_NAMES,
  SUBMISSION_PHASE_NAME,
} from '../constants/review.constants';
import { ReviewService } from '../../review/review.service';
import { getRequiredReviewerCountForPhase } from '../utils/reviewer.utils';
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
    private readonly configService: ConfigService,
  ) {
    this.appealsPhaseNames = new Set(
      this.getStringArray('autopilot.appealsPhaseNames', [
        ...Array.from(DEFAULT_APPEALS_PHASE_NAMES),
      ]),
    );
    this.appealsResponsePhaseNames = new Set(
      this.getStringArray('autopilot.appealsResponsePhaseNames', [
        ...Array.from(DEFAULT_APPEALS_RESPONSE_PHASE_NAMES),
      ]),
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
    this.phaseScheduleManager.handlePhaseTransition(message);
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
      if (!review || !review.phaseId) {
        this.logger.warn(
          `Review ${reviewId} not found or missing phase reference for challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.isChallengeActive(challenge.status)) {
        return;
      }

      const phase = challenge.phases.find((p) => p.id === review.phaseId);
      if (!phase) {
        this.logger.warn(
          `Phase ${review.phaseId} not found on challenge ${challengeId} when handling review completion.`,
        );
        return;
      }

      if (!phase.isOpen) {
        this.logger.debug(
          `Phase ${phase.id} already closed for challenge ${challengeId}; ignoring review completion event.`,
        );
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

      if (!REVIEW_PHASE_NAMES.has(phase.name)) {
        return;
      }

      const templatePhaseId = phase.phaseId ?? phase.id;
      const requiredReviewers = getRequiredReviewerCountForPhase(
        challenge.reviewers,
        templatePhaseId,
      );
      if (requiredReviewers === 0) {
        return;
      }

      const submissionCount = Math.max(
        challenge.numOfSubmissions ?? 0,
        await this.reviewService.getActiveSubmissionCount(challengeId),
      );

      if (submissionCount === 0) {
        return;
      }

      const requiredReviews = submissionCount * requiredReviewers;
      const completedReviews =
        await this.reviewService.getCompletedReviewCountForPhase(phase.id);

      if (completedReviews < requiredReviews) {
        this.logger.debug(
          `Review phase ${phase.id} for challenge ${challengeId} has ${completedReviews}/${requiredReviews} completed reviews.`,
        );
        return;
      }

      this.logger.log(
        `All required reviews (${completedReviews}) completed for phase ${phase.id} on challenge ${challengeId}. Closing Review phase early.`,
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
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle review completion for challenge ${challengeId}: ${err.message}`,
        err.stack,
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

      if (!this.isChallengeActive(challenge.status)) {
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
    try {
      await this.first2FinishService.handleSubmissionByChallengeId(
        payload.challengeId,
        payload.submissionId,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle First2Finish submission for challenge ${payload.challengeId}: ${err.message}`,
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

      if (
        !this.first2FinishService.isChallengeActive(challengeDetails.status)
      ) {
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

  private isChallengeActive(status?: string): boolean {
    return this.first2FinishService.isChallengeActive(status);
  }

  private getStringArray(path: string, fallback: string[]): string[] {
    const value = this.configService.get<unknown>(path);

    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
        .filter((item) => item.length > 0);
      if (normalized.length) {
        return normalized;
      }
    }

    if (typeof value === 'string' && value.length > 0) {
      const normalized = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (normalized.length) {
        return normalized;
      }
    }

    return fallback;
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

  scheduleNextPhases(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): void {
    this.logger.warn(
      `[PHASE CHAIN] scheduleNextPhases is deprecated, use openAndScheduleNextPhases instead`,
    );
    void this.openAndScheduleNextPhases(
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
