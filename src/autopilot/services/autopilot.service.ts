import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
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
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { AUTOPILOT_COMMANDS } from '../../common/constants/commands.constants';
import {
  DEFAULT_APPEALS_PHASE_NAMES,
  DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
  ITERATIVE_REVIEW_PHASE_NAME,
  PHASE_ROLE_MAP,
  REVIEW_PHASE_NAMES,
  SUBMISSION_PHASE_NAME,
} from '../constants/review.constants';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';

const SUBMISSION_NOTIFICATION_CREATE_TOPIC = 'submission.notification.create';
const FIRST2FINISH_TYPE = 'first2finish';

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  private activeSchedules = new Map<string, string>();
  private readonly reviewRoleNames: Set<string>;
  private readonly appealsPhaseNames: Set<string>;
  private readonly appealsResponsePhaseNames: Set<string>;
  private readonly postMortemRoles: string[];

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly reviewAssignmentService: ReviewAssignmentService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
  ) {
    // Set up the phase chain callback to handle next phase opening and scheduling
    this.schedulerService.setPhaseChainCallback(
      (
        challengeId: string,
        projectId: number,
        projectStatus: string,
        nextPhases: IPhase[],
      ) => {
        void this.openAndScheduleNextPhases(
          challengeId,
          projectId,
          projectStatus,
          nextPhases,
        );
      },
    );

    this.postMortemRoles = this.getStringArray('autopilot.postMortemRoles', [
      'Reviewer',
      'Copilot',
    ]);
    this.reviewRoleNames = this.computeReviewRoleNames();
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

  private isChallengeActive(status?: string): boolean {
    return (status ?? '').toUpperCase() === 'ACTIVE';
  }

  private isFirst2FinishChallenge(type?: string): boolean {
    return (type ?? '').toLowerCase() === FIRST2FINISH_TYPE;
  }

  async schedulePhaseTransition(
    phaseData: PhaseTransitionPayload,
  ): Promise<string> {
    try {
      const phaseKey = `${phaseData.challengeId}:${phaseData.phaseId}`;

      const existingJobId = this.activeSchedules.get(phaseKey);
      if (existingJobId) {
        this.logger.log(
          `Canceling existing schedule for phase ${phaseKey} before rescheduling.`,
        );
        const canceled =
          await this.schedulerService.cancelScheduledTransition(existingJobId);
        if (!canceled) {
          this.logger.warn(
            `Failed to cancel existing schedule ${existingJobId} for phase ${phaseKey}`,
          );
        }
        this.activeSchedules.delete(phaseKey);
      }

      const jobId =
        await this.schedulerService.schedulePhaseTransition(phaseData);
      this.activeSchedules.set(phaseKey, jobId);

      this.logger.log(
        `Scheduled phase transition for challenge ${phaseData.challengeId}, phase ${phaseData.phaseId} at ${phaseData.date}`,
      );
      return jobId;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to schedule phase transition: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  async cancelPhaseTransition(
    challengeId: string,
    phaseId: string,
  ): Promise<boolean> {
    const phaseKey = `${challengeId}:${phaseId}`;
    const jobId = this.activeSchedules.get(phaseKey);

    if (!jobId) {
      this.logger.warn(`No active schedule found for phase ${phaseKey}`);
      return false;
    }

    const canceled =
      await this.schedulerService.cancelScheduledTransition(jobId);
    if (canceled) {
      this.activeSchedules.delete(phaseKey);
      this.logger.log(`Canceled scheduled transition for phase ${phaseKey}`);
      return true;
    }

    this.logger.warn(
      `Unable to cancel scheduled transition for phase ${phaseKey}; job may have already executed. Removing stale reference.`,
    );
    this.activeSchedules.delete(phaseKey);
    return false;
  }

  async reschedulePhaseTransition(
    challengeId: string,
    newPhaseData: PhaseTransitionPayload,
  ): Promise<string> {
    const phaseKey = `${challengeId}:${newPhaseData.phaseId}`;
    const existingJobId = this.activeSchedules.get(phaseKey);
    let wasRescheduled = false;

    if (existingJobId) {
      const scheduledJob =
        this.schedulerService.getScheduledTransition(existingJobId);

      if (!scheduledJob) {
        this.logger.warn(
          `No scheduled job found for phase ${phaseKey}, but it was in the active map. Scheduling new job.`,
        );
      } else if (scheduledJob.date && newPhaseData.date) {
        const existingTime = new Date(scheduledJob.date).getTime();
        const newTime = new Date(newPhaseData.date).getTime();

        if (existingTime === newTime) {
          this.logger.log(
            `No change detected for phase ${phaseKey}, skipping reschedule.`,
          );
          return existingJobId;
        }

        this.logger.log(
          `Detected change in end time for phase ${phaseKey}, rescheduling.`,
        );
        wasRescheduled = true;
      }
    }

    const newJobId = await this.schedulePhaseTransition(newPhaseData);

    if (wasRescheduled) {
      this.logger.log(
        `Successfully rescheduled phase ${newPhaseData.phaseId} with new end time: ${newPhaseData.date}`,
      );
    }

    return newJobId;
  }

  handlePhaseTransition(message: PhaseTransitionPayload): void {
    this.logger.log(
      `Consumed phase transition event: ${JSON.stringify(message)}`,
    );

    if (!this.isChallengeActive(message.projectStatus)) {
      this.logger.log(
        `Ignoring phase transition for challenge ${message.challengeId} with status ${message.projectStatus}; only ACTIVE challenges are processed.`,
      );
      return;
    }

    if (message.state === 'START') {
      // Advance the phase (open it) using the scheduler service
      void (async () => {
        try {
          await this.schedulerService.advancePhase(message);
          this.logger.log(
            `Successfully processed START event for phase ${message.phaseId} (challenge ${message.challengeId})`,
          );
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to advance phase ${message.phaseId} for challenge ${message.challengeId}: ${err.message}`,
            err.stack,
          );
        }
      })();
    } else if (message.state === 'END') {
      // Advance the phase (close it) using the scheduler service
      void (async () => {
        try {
          await this.schedulerService.advancePhase(message);
          this.logger.log(
            `Successfully processed END event for phase ${message.phaseId} (challenge ${message.challengeId})`,
          );

          // Clean up the scheduled job after closing the phase
          const canceled = await this.cancelPhaseTransition(
            message.challengeId,
            message.phaseId,
          );
          if (canceled) {
            this.logger.log(
              `Cleaned up job for phase ${message.phaseId} (challenge ${message.challengeId}) from registry after consuming event.`,
            );
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to advance phase ${message.phaseId} for challenge ${message.challengeId}: ${err.message}`,
            err.stack,
          );
        }
      })();
    }
  }

  async handleNewChallenge(challenge: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(
      `Handling new challenge creation: ${JSON.stringify(challenge)}`,
    );
    try {
      // Refactored: Use getChallengeById as required
      const challengeDetails = await this.challengeApiService.getChallengeById(
        challenge.id,
      );

      if (!this.isChallengeActive(challengeDetails.status)) {
        this.logger.log(
          `Skipping challenge ${challenge.id} with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
        );
        return;
      }

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Challenge ${challenge.id} has no phases to schedule.`,
        );
        return;
      }

      // Find the phases that should be scheduled (similar logic to PhaseAdvancer)
      const phasesToSchedule = this.findPhasesToSchedule(
        challengeDetails.phases,
      );

      if (phasesToSchedule.length === 0) {
        this.logger.log(
          `No phase needs to be scheduled for new challenge ${challenge.id}`,
        );
        return;
      }

      const now = new Date();
      const scheduledSummaries: string[] = [];

      for (const nextPhase of phasesToSchedule) {
        const shouldOpen =
          !nextPhase.isOpen &&
          !nextPhase.actualEndDate &&
          nextPhase.scheduledStartDate &&
          new Date(nextPhase.scheduledStartDate) <= now;

        const scheduleDate = shouldOpen
          ? nextPhase.scheduledStartDate
          : nextPhase.scheduledEndDate;
        const state = shouldOpen ? 'START' : 'END';

        if (!scheduleDate) {
          this.logger.warn(
            `Next phase ${nextPhase.id} for new challenge ${challenge.id} has no scheduled ${shouldOpen ? 'start' : 'end'} date. Skipping.`,
          );
          continue;
        }

        const phaseData: PhaseTransitionPayload = {
          projectId: challengeDetails.projectId,
          challengeId: challengeDetails.id,
          phaseId: nextPhase.id,
          phaseTypeName: nextPhase.name,
          state,
          operator: AutopilotOperator.SYSTEM_NEW_CHALLENGE,
          projectStatus: challengeDetails.status,
          date: scheduleDate,
        };

        await this.schedulePhaseTransition(phaseData);
        scheduledSummaries.push(
          `${nextPhase.name} (${nextPhase.id}) -> ${state} @ ${scheduleDate}`,
        );
      }

      if (scheduledSummaries.length === 0) {
        this.logger.warn(
          `Unable to schedule any phases for new challenge ${challenge.id} due to missing schedule data.`,
        );
        return;
      }

      this.logger.log(
        `Scheduled ${scheduledSummaries.length} phase(s) for new challenge ${challenge.id}: ${scheduledSummaries.join('; ')}`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling new challenge creation for id ${challenge.id}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleChallengeUpdate(message: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(`Handling challenge update: ${JSON.stringify(message)}`);

    try {
      // Refactored: Use getChallengeById as required
      const challengeDetails = await this.challengeApiService.getChallengeById(
        message.id,
      );

      if (!this.isChallengeActive(challengeDetails.status)) {
        this.logger.log(
          `Skipping challenge ${message.id} update with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
        );
        return;
      }

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Updated challenge ${message.id} has no phases to process.`,
        );
        return;
      }

      const phasesToSchedule = this.findPhasesToSchedule(
        challengeDetails.phases,
      );

      if (phasesToSchedule.length === 0) {
        this.logger.log(
          `No phase needs to be rescheduled for updated challenge ${message.id}`,
        );
        return;
      }

      const now = new Date();
      const rescheduledSummaries: string[] = [];

      for (const nextPhase of phasesToSchedule) {
        const shouldOpen =
          !nextPhase.isOpen &&
          !nextPhase.actualEndDate &&
          nextPhase.scheduledStartDate &&
          new Date(nextPhase.scheduledStartDate) <= now;

        const scheduleDate = shouldOpen
          ? nextPhase.scheduledStartDate
          : nextPhase.scheduledEndDate;
        const state = shouldOpen ? 'START' : 'END';

        if (!scheduleDate) {
          this.logger.warn(
            `Next phase ${nextPhase.id} for updated challenge ${message.id} has no scheduled ${shouldOpen ? 'start' : 'end'} date. Skipping.`,
          );
          continue;
        }

        const payload: PhaseTransitionPayload = {
          projectId: challengeDetails.projectId,
          challengeId: challengeDetails.id,
          phaseId: nextPhase.id,
          phaseTypeName: nextPhase.name,
          operator: message.operator,
          projectStatus: challengeDetails.status,
          date: scheduleDate,
          state,
        };

        await this.reschedulePhaseTransition(challengeDetails.id, payload);
        rescheduledSummaries.push(
          `${nextPhase.name} (${nextPhase.id}) -> ${state} @ ${scheduleDate}`,
        );
      }

      if (rescheduledSummaries.length === 0) {
        this.logger.warn(
          `Unable to reschedule any phases for updated challenge ${message.id} due to missing schedule data.`,
        );
        return;
      }

      this.logger.log(
        `Rescheduled ${rescheduledSummaries.length} phase(s) for updated challenge ${message.id}: ${rescheduledSummaries.join('; ')}`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling challenge update: ${err.message}`,
        err.stack,
      );
    }
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
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed processing submission aggregate for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleResourceCreated(payload: ResourceEventPayload): Promise<void> {
    const { challengeId, id: resourceId } = payload;

    if (!challengeId) {
      this.logger.warn('Resource created event missing challengeId.', payload);
      return;
    }

    try {
      const resource = await this.resourcesService.getResourceById(resourceId);
      const roleName = resource?.roleName
        ? resource.roleName.trim()
        : await this.resourcesService.getRoleNameById(payload.roleId);

      if (resource && resource.challengeId !== challengeId) {
        this.logger.warn(
          `Resource ${resourceId} reported for challenge ${challengeId}, but database indicates challenge ${resource.challengeId}. Proceeding with payload challenge ID.`,
        );
      }

      if (!roleName) {
        this.logger.warn(
          `Unable to determine role name for resource ${resourceId} on challenge ${challengeId}.`,
        );
      }

      if (roleName && !this.isReviewRole(roleName)) {
        this.logger.debug(
          `Ignoring resource ${resourceId} with non-review role ${roleName} for challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.isChallengeActive(challenge.status)) {
        this.logger.debug(
          `Skipping resource create for challenge ${challengeId} with status ${challenge.status}.`,
        );
        return;
      }

      const openReviewPhases = challenge.phases?.filter(
        (phase) =>
          phase.isOpen &&
          REVIEW_PHASE_NAMES.has(phase.name) &&
          phase.name !== ITERATIVE_REVIEW_PHASE_NAME,
      );

      if (openReviewPhases?.length) {
        for (const phase of openReviewPhases) {
          try {
            await this.phaseReviewService.handlePhaseOpened(
              challengeId,
              phase.id,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to synchronize pending reviews for phase ${phase.id} on challenge ${challengeId} after resource creation: ${err.message}`,
              err.stack,
            );
          }
        }
      }

      if (
        roleName &&
        this.isFirst2FinishChallenge(challenge.type) &&
        this.isIterativeReviewerRole(roleName)
      ) {
        await this.processFirst2FinishReviewerAdded(challenge);
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle resource creation for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleResourceDeleted(payload: ResourceEventPayload): Promise<void> {
    const { challengeId, id: resourceId } = payload;

    if (!challengeId) {
      this.logger.warn('Resource deleted event: Missing challengeId.', payload);
      return;
    }

    try {
      const roleName = await this.resourcesService.getRoleNameById(
        payload.roleId,
      );

      if (roleName && !this.isReviewRole(roleName)) {
        this.logger.debug(
          `Ignoring resource ${resourceId} deletion for non-review role ${roleName} on challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.isChallengeActive(challenge.status)) {
        return;
      }

      const reviewPhases = challenge.phases?.filter((phase) =>
        REVIEW_PHASE_NAMES.has(phase.name),
      );

      if (reviewPhases?.length) {
        for (const phase of reviewPhases) {
          try {
            await this.reviewService.deletePendingReviewsForResource(
              phase.id,
              resourceId,
              challengeId,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to delete pending reviews for phase ${phase.id} on challenge ${challengeId}: ${err.message}`,
              err.stack,
            );
          }

          await this.reviewAssignmentService.handleReviewerRemoved(
            challengeId,
            {
              id: phase.id,
              phaseId: phase.phaseId,
              name: phase.name,
            },
          );
        }
      }

      if (
        roleName &&
        this.isFirst2FinishChallenge(challenge.type) &&
        this.isIterativeReviewerRole(roleName)
      ) {
        this.logger.warn(
          `Iterative reviewer removed from challenge ${challengeId}; awaiting reassignment before continuing F2F processing.`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle resource deletion for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
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
        await this.processIterativeReviewCompletion(
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

      const requiredReviewers = this.getRequiredReviewerCount(challenge, phase);
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
      const challenge = await this.challengeApiService.getChallengeById(
        payload.challengeId,
      );

      if (!this.isFirst2FinishChallenge(challenge.type)) {
        return;
      }

      await this.processFirst2FinishSubmission(challenge, payload.submissionId);
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
            await this.handleSinglePhaseCancellation(challengeId, phaseId);
          } else {
            const challengeId = message.challengeId;
            if (!challengeId) {
              this.logger.warn(
                `${AUTOPILOT_COMMANDS.CANCEL_SCHEDULE}: missing challengeId`,
              );
              return;
            }
            await this.cancelAllPhasesForChallenge(challengeId);
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

          void (async () => {
            try {
              const challengeDetails =
                await this.challengeApiService.getChallengeById(challengeId);

              if (!challengeDetails) {
                this.logger.error(
                  `Could not find challenge with ID ${challengeId} to reschedule.`,
                );
                return;
              }

              if (!this.isChallengeActive(challengeDetails.status)) {
                this.logger.log(
                  `${AUTOPILOT_COMMANDS.RESCHEDULE_PHASE}: ignoring challenge ${challengeId} with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
                );
                return;
              }

              const phaseTypeName =
                await this.challengeApiService.getPhaseTypeName(
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

              await this.reschedulePhaseTransition(
                challengeDetails.id,
                payload,
              );
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `Error in reschedule_phase command: ${err.message}`,
                err.stack,
              );
            }
          })();
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

  private async handleSinglePhaseCancellation(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    await this.cancelPhaseTransition(challengeId, phaseId);
  }

  private async cancelAllPhasesForChallenge(
    challengeId: string,
  ): Promise<void> {
    const phaseKeys = Array.from(this.activeSchedules.keys()).filter((key) =>
      key.startsWith(`${challengeId}:`),
    );

    for (const key of phaseKeys) {
      const [, phaseId] = key.split(':');
      if (phaseId) {
        await this.handleSinglePhaseCancellation(challengeId, phaseId);
      }
    }
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

  private computeReviewRoleNames(): Set<string> {
    const roles = new Set<string>();
    for (const names of Object.values(PHASE_ROLE_MAP)) {
      for (const name of names) {
        roles.add(name);
      }
    }
    this.postMortemRoles.forEach((role) => roles.add(role));
    return roles;
  }

  private isReviewRole(roleName?: string | null): boolean {
    if (!roleName) {
      return false;
    }
    return this.reviewRoleNames.has(roleName);
  }

  private isIterativeReviewerRole(roleName: string): boolean {
    const iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];
    return iterativeRoles.includes(roleName);
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

  private getRequiredReviewerCount(
    challenge: IChallenge,
    phase: IPhase,
  ): number {
    const reviewers = challenge.reviewers?.filter(
      (reviewer) =>
        reviewer.isMemberReview && reviewer.phaseId === phase.phaseId,
    );

    if (!reviewers?.length) {
      return 0;
    }

    return reviewers.reduce((total, reviewer) => {
      const count = reviewer.memberReviewerCount ?? 1;
      return total + Math.max(count, 0);
    }, 0);
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

    const iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];
    const reviewers = await this.resourcesService.getReviewerResources(
      challenge.id,
      iterativeRoles,
    );

    if (!reviewers.length) {
      this.logger.debug(
        `Iterative reviewer not yet assigned for challenge ${challenge.id}; awaiting resource creation.`,
      );
      return;
    }

    const scorecardId = this.getScorecardIdForPhase(challenge, iterativePhase);
    if (!scorecardId) {
      this.logger.warn(
        `Unable to determine scorecard for iterative review phase ${iterativePhase.id} on challenge ${challenge.id}.`,
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

    const assigned = await this.assignNextIterativeReview(
      challenge.id,
      iterativePhase,
      reviewers[0].id,
      scorecardId,
      submissionId,
    );

    if (!assigned) {
      this.logger.debug(
        `No pending submissions found for iterative review on challenge ${challenge.id}.`,
      );
    }
  }

  private async processFirst2FinishReviewerAdded(
    challenge: IChallenge,
  ): Promise<void> {
    this.logger.debug(
      `Iterative reviewer ready for challenge ${challenge.id}; evaluating pending submissions.`,
    );
    await this.processFirst2FinishSubmission(challenge);
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

  private async processIterativeReviewCompletion(
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

    const iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];
    const reviewers = await this.resourcesService.getReviewerResources(
      challengeId,
      iterativeRoles,
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

  /**
   * Find the phases that should be scheduled based on current phase state.
   * Similar logic to PhaseAdvancer.js - ensure every phase that needs attention is handled.
   */
  private findPhasesToSchedule(phases: IPhase[]): IPhase[] {
    const now = new Date();

    // First, check for phases that should be open but aren't
    const phasesToOpen = phases
      .filter((phase) => {
        if (phase.isOpen || phase.actualEndDate) {
          return false; // Already open or already ended
        }

        const startTime = new Date(phase.scheduledStartDate);
        if (startTime > now) {
          return false; // Not time to start yet
        }

        // Check if predecessor requirements are met
        if (!phase.predecessor) {
          return true; // No predecessor, ready to start
        }

        const predecessor = phases.find(
          (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
        );

        return Boolean(predecessor?.actualEndDate); // Predecessor has ended
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledStartDate).getTime() -
          new Date(b.scheduledStartDate).getTime(),
      );

    if (phasesToOpen.length > 0) {
      return phasesToOpen;
    }

    // Next, check for open phases that should be closed
    const openPhases = phases
      .filter((phase) => phase.isOpen)
      .sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      );

    if (openPhases.length > 0) {
      return openPhases;
    }

    // Finally, look for future phases that need to be scheduled
    const futurePhases = phases.filter(
      (phase) =>
        !phase.actualStartDate && // hasn't started yet
        !phase.actualEndDate && // hasn't ended yet
        phase.scheduledStartDate && // has a scheduled start date
        new Date(phase.scheduledStartDate) > now, // starts in the future
    );

    // Find phases that are ready to start (no predecessor or predecessor is closed)
    const readyPhases = futurePhases.filter((phase) => {
      if (!phase.predecessor) {
        return true; // No predecessor, ready to start
      }

      const predecessor = phases.find(
        (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
      );

      return Boolean(predecessor?.actualEndDate);
    });

    if (readyPhases.length === 0) {
      return [];
    }

    // Return the phases with the earliest scheduled start (handle identical start times)
    const sortedReady = readyPhases.sort(
      (a, b) =>
        new Date(a.scheduledStartDate).getTime() -
        new Date(b.scheduledStartDate).getTime(),
    );

    const earliest = new Date(sortedReady[0].scheduledStartDate).getTime();

    return sortedReady.filter(
      (phase) => new Date(phase.scheduledStartDate).getTime() === earliest,
    );
  }

  /**
   * Open and schedule next phases in the transition chain
   */
  async openAndScheduleNextPhases(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): Promise<void> {
    if (!this.isChallengeActive(projectStatus)) {
      this.logger.log(
        `[PHASE CHAIN] Challenge ${challengeId} is not ACTIVE (status: ${projectStatus}), skipping phase chain processing.`,
      );
      return;
    }

    if (!nextPhases || nextPhases.length === 0) {
      this.logger.log(
        `[PHASE CHAIN] No next phases to open for challenge ${challengeId}`,
      );
      return;
    }

    this.logger.log(
      `[PHASE CHAIN] Opening and scheduling ${nextPhases.length} next phases for challenge ${challengeId}`,
    );

    let processedCount = 0;
    let deferredCount = 0;

    for (const nextPhase of nextPhases) {
      const openPhaseCallback = async () =>
        await this.openPhaseAndSchedule(
          challengeId,
          projectId,
          projectStatus,
          nextPhase,
        );

      try {
        const canOpenNow =
          await this.reviewAssignmentService.ensureAssignmentsOrSchedule(
            challengeId,
            nextPhase,
            openPhaseCallback,
          );

        if (!canOpenNow) {
          deferredCount++;
          continue;
        }

        const opened = await openPhaseCallback();
        if (opened) {
          processedCount++;
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[PHASE CHAIN] Failed to open and schedule phase ${nextPhase.name} (${nextPhase.id}) for challenge ${challengeId}: ${err.message}`,
          err.stack,
        );
      }
    }

    const summaryParts = [
      `opened and scheduled ${processedCount} out of ${nextPhases.length}`,
    ];
    if (deferredCount > 0) {
      summaryParts.push(
        `deferred ${deferredCount} awaiting reviewer assignments`,
      );
    }

    this.logger.log(
      `[PHASE CHAIN] ${summaryParts.join(', ')} for challenge ${challengeId}`,
    );
  }

  private async openPhaseAndSchedule(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    phase: IPhase,
  ): Promise<boolean> {
    if (!this.isChallengeActive(projectStatus)) {
      this.logger.log(
        `[PHASE CHAIN] Challenge ${challengeId} is not ACTIVE (status: ${projectStatus}); skipping phase ${phase.name} (${phase.id}).`,
      );
      return false;
    }

    this.logger.log(
      `[PHASE CHAIN] Opening phase ${phase.name} (${phase.id}) for challenge ${challengeId}`,
    );

    const openResult = await this.challengeApiService.advancePhase(
      challengeId,
      phase.id,
      'open',
    );

    if (!openResult.success) {
      this.logger.error(
        `[PHASE CHAIN] Failed to open phase ${phase.name} (${phase.id}) for challenge ${challengeId}: ${openResult.message}`,
      );
      return false;
    }

    this.reviewAssignmentService.clearPolling(challengeId, phase.id);

    this.logger.log(
      `[PHASE CHAIN] Successfully opened phase ${phase.name} (${phase.id}) for challenge ${challengeId}`,
    );

    if (REVIEW_PHASE_NAMES.has(phase.name)) {
      try {
        await this.phaseReviewService.handlePhaseOpened(challengeId, phase.id);
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[PHASE CHAIN] Failed to prepare review records for phase ${phase.name} (${phase.id}) on challenge ${challengeId}: ${err.message}`,
          err.stack,
        );
      }
    }

    const updatedPhase =
      openResult.updatedPhases?.find((p) => p.id === phase.id) || phase;

    if (!updatedPhase.scheduledEndDate) {
      this.logger.warn(
        `[PHASE CHAIN] Opened phase ${phase.name} (${phase.id}) has no scheduled end date, skipping scheduling`,
      );
      return false;
    }

    const phaseKey = `${challengeId}:${phase.id}`;
    if (this.activeSchedules.has(phaseKey)) {
      this.logger.log(
        `[PHASE CHAIN] Phase ${phase.name} (${phase.id}) is already scheduled, skipping`,
      );
      return false;
    }

    const nextPhaseData: PhaseTransitionPayload = {
      projectId,
      challengeId,
      phaseId: updatedPhase.id,
      phaseTypeName: updatedPhase.name,
      state: 'END',
      operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
      projectStatus,
      date: updatedPhase.scheduledEndDate,
    };

    const jobId = await this.schedulePhaseTransition(nextPhaseData);
    this.logger.log(
      `[PHASE CHAIN] Scheduled opened phase ${updatedPhase.name} (${updatedPhase.id}) for closure at ${updatedPhase.scheduledEndDate} with job ID: ${jobId}`,
    );
    return true;
  }

  /**
   * @deprecated Use openAndScheduleNextPhases instead
   * Schedule next phases in the transition chain
   */
  scheduleNextPhases(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): void {
    this.logger.warn(
      `[PHASE CHAIN] scheduleNextPhases is deprecated, use openAndScheduleNextPhases instead`,
    );
    // Convert to async call
    void this.openAndScheduleNextPhases(
      challengeId,
      projectId,
      projectStatus,
      nextPhases,
    );
  }

  getActiveSchedules(): Map<string, string> {
    return new Map(this.activeSchedules);
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

  /**
   * Get detailed information about scheduled transitions for debugging
   */
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
