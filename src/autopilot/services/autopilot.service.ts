import { Injectable, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import {
  PhaseTransitionPayload,
  ChallengeUpdatePayload,
  CommandPayload,
  AutopilotOperator,
} from '../interfaces/autopilot.interface';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { IPhase } from '../../challenge/interfaces/challenge.interface';
import { AUTOPILOT_COMMANDS } from '../../common/constants/commands.constants';
import { REVIEW_PHASE_NAMES } from '../constants/review.constants';

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  private activeSchedules = new Map<string, string>();

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly reviewAssignmentService: ReviewAssignmentService,
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
  }

  schedulePhaseTransition(phaseData: PhaseTransitionPayload): string {
    try {
      const phaseKey = `${phaseData.challengeId}:${phaseData.phaseId}`;

      const existingJobId = this.activeSchedules.get(phaseKey);
      if (existingJobId) {
        this.logger.log(
          `Canceling existing schedule for phase ${phaseKey} before rescheduling.`,
        );
        this.schedulerService.cancelScheduledTransition(existingJobId);
        this.activeSchedules.delete(phaseKey);
      }

      const jobId = this.schedulerService.schedulePhaseTransition(phaseData);
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

  cancelPhaseTransition(challengeId: string, phaseId: string): boolean {
    const phaseKey = `${challengeId}:${phaseId}`;
    const jobId = this.activeSchedules.get(phaseKey);

    if (!jobId) {
      this.logger.warn(`No active schedule found for phase ${phaseKey}`);
      return false;
    }

    const canceled = this.schedulerService.cancelScheduledTransition(jobId);
    if (canceled) {
      this.activeSchedules.delete(phaseKey);
      this.logger.log(`Canceled scheduled transition for phase ${phaseKey}`);
    }

    return canceled;
  }

  reschedulePhaseTransition(
    challengeId: string,
    newPhaseData: PhaseTransitionPayload,
  ): string {
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

    const newJobId = this.schedulePhaseTransition(newPhaseData);

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
          const canceled = this.cancelPhaseTransition(
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

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Challenge ${challenge.id} has no phases to schedule.`,
        );
        return;
      }

      // Find the next phase that should be scheduled (similar to PhaseAdvancer logic)
      const nextPhase = this.findNextPhaseToSchedule(challengeDetails.phases);

      if (!nextPhase) {
        this.logger.log(
          `No phase needs to be scheduled for new challenge ${challenge.id}`,
        );
        return;
      }

      // Determine if we should schedule for start or end based on phase state
      const now = new Date();
      const shouldOpen =
        !nextPhase.isOpen &&
        !nextPhase.actualEndDate &&
        new Date(nextPhase.scheduledStartDate) <= now;

      const scheduleDate = shouldOpen
        ? nextPhase.scheduledStartDate
        : nextPhase.scheduledEndDate;
      const state = shouldOpen ? 'START' : 'END';

      if (!scheduleDate) {
        this.logger.warn(
          `Next phase ${nextPhase.id} for new challenge ${challenge.id} has no scheduled ${shouldOpen ? 'start' : 'end'} date. Skipping.`,
        );
        return;
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

      this.schedulePhaseTransition(phaseData);
      this.logger.log(
        `Scheduled next phase ${nextPhase.name} (${nextPhase.id}) for new challenge ${challenge.id}`,
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

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Updated challenge ${message.id} has no phases to process.`,
        );
        return;
      }

      // Find the next phase that should be scheduled (similar to PhaseAdvancer logic)
      const nextPhase = this.findNextPhaseToSchedule(challengeDetails.phases);

      if (!nextPhase) {
        this.logger.log(
          `No phase needs to be rescheduled for updated challenge ${message.id}`,
        );
        return;
      }

      // Determine if we should schedule for start or end based on phase state
      const now = new Date();
      const shouldOpen =
        !nextPhase.isOpen &&
        !nextPhase.actualEndDate &&
        new Date(nextPhase.scheduledStartDate) <= now;

      const scheduleDate = shouldOpen
        ? nextPhase.scheduledStartDate
        : nextPhase.scheduledEndDate;
      const state = shouldOpen ? 'START' : 'END';

      if (!scheduleDate) {
        this.logger.warn(
          `Next phase ${nextPhase.id} for updated challenge ${message.id} has no scheduled ${shouldOpen ? 'start' : 'end'} date. Skipping.`,
        );
        return;
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

      this.logger.log(
        `Rescheduling next phase ${nextPhase.name} (${nextPhase.id}) for updated challenge ${message.id}`,
      );
      this.reschedulePhaseTransition(challengeDetails.id, payload);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling challenge update: ${err.message}`,
        err.stack,
      );
    }
  }

  handleCommand(message: CommandPayload): void {
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
            const canceled = this.cancelPhaseTransition(challengeId, phaseId);
            if (canceled) {
              this.logger.log(
                `Canceled scheduled transition for phase ${challengeId}:${phaseId}`,
              );
            } else {
              this.logger.warn(
                `No active schedule found for phase ${challengeId}:${phaseId}`,
              );
            }
          } else {
            const challengeId = message.challengeId;
            if (!challengeId) {
              this.logger.warn(
                `${AUTOPILOT_COMMANDS.CANCEL_SCHEDULE}: missing challengeId`,
              );
              return;
            }
            for (const key of this.activeSchedules.keys()) {
              if (key.startsWith(`${challengeId}:`)) {
                const phaseIdFromKey = key.split(':')[1];
                this.cancelPhaseTransition(challengeId, phaseIdFromKey);
              }
            }
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

              this.reschedulePhaseTransition(challengeDetails.id, payload);
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

  /**
   * Find the next phase that should be scheduled based on current phase state.
   * Similar logic to PhaseAdvancer.js - only schedule the next phase that should advance.
   */
  private findNextPhaseToSchedule(phases: IPhase[]): IPhase | null {
    const now = new Date();

    // First, check for phases that should be open but aren't
    const phasesToOpen = phases.filter((phase) => {
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
    });

    if (phasesToOpen.length > 0) {
      // Return the earliest phase that should be opened
      return phasesToOpen.sort(
        (a, b) =>
          new Date(a.scheduledStartDate).getTime() -
          new Date(b.scheduledStartDate).getTime(),
      )[0];
    }

    // Next, check for open phases that should be closed
    const openPhases = phases.filter((phase) => phase.isOpen);

    if (openPhases.length > 0) {
      // Return the earliest phase that should end
      return openPhases.sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      )[0];
    }

    // Finally, look for future phases that need to be scheduled
    const futurePhases = phases.filter(
      (phase) =>
        !phase.actualStartDate && // hasn't started yet
        !phase.actualEndDate && // hasn't ended yet
        phase.scheduledStartDate && // has a scheduled start date
        new Date(phase.scheduledStartDate) > now, // starts in the future
    );

    if (futurePhases.length === 0) {
      return null;
    }

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
      return null;
    }

    // Return the earliest scheduled phase
    return readyPhases.sort(
      (a, b) =>
        new Date(a.scheduledStartDate).getTime() -
        new Date(b.scheduledStartDate).getTime(),
    )[0];
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
        const canOpenNow = await this.reviewAssignmentService.ensureAssignmentsOrSchedule(
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

    const summaryParts = [`opened and scheduled ${processedCount} out of ${nextPhases.length}`];
    if (deferredCount > 0) {
      summaryParts.push(`deferred ${deferredCount} awaiting reviewer assignments`);
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

    const jobId = this.schedulePhaseTransition(nextPhaseData);
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
