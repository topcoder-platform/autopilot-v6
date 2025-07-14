/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import {
  PhaseTransitionPayload,
  ChallengeUpdatePayload,
  CommandPayload,
} from '../interfaces/autopilot.interface';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { AUTOPILOT_COMMANDS } from '../../common/constants/commands.constants';

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  // Store active schedules for tracking purposes
  private activeSchedules = new Map<string, string>();

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
  ) {}

  /**
   * Schedule a phase transition - HIGH LEVEL business logic
   * Handles existing schedule cleanup and tracking
   */
  schedulePhaseTransition(phaseData: PhaseTransitionPayload): string {
    try {
      const phaseKey = `${phaseData.projectId}:${phaseData.phaseId}`;

      // Cancel existing schedule if it exists
      const existingJobId = this.activeSchedules.get(phaseKey);
      if (existingJobId) {
        this.logger.log(`Canceling existing schedule for phase ${phaseKey}`);
        this.schedulerService.cancelScheduledTransition(existingJobId);
        this.activeSchedules.delete(phaseKey);
      }

      // Check if date is in the past - if so, process immediately instead of throwing error
      const endTime = phaseData.date ? new Date(phaseData.date).getTime() : 0;
      if (endTime <= Date.now()) {
        this.logger.log(
          `Phase ${phaseKey} end time is in the past, processing immediately`,
        );
        void this.handlePhaseTransition(phaseData);
        return `immediate-${phaseKey}`;
      }

      // Schedule new transition
      const jobId = this.schedulerService.schedulePhaseTransition(phaseData);
      this.activeSchedules.set(phaseKey, jobId);

      this.logger.log(
        `Scheduled phase transition for challenge ${phaseData.projectId}, phase ${phaseData.phaseId} at ${phaseData.date}`,
      );
      return jobId;
    } catch (error) {
      this.logger.error(
        `Failed to schedule phase transition: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Cancel a scheduled phase transition - HIGH LEVEL business logic
   * Handles tracking cleanup
   */
  cancelPhaseTransition(projectId: number, phaseId: number): boolean {
    const phaseKey = `${projectId}:${phaseId}`;
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

  /**
   * Reschedule a phase transition - BUSINESS LOGIC operation
   * This is the high-level method that combines cancel + schedule with proper logging
   */
  async reschedulePhaseTransition(
    projectId: number,
    newPhaseData: PhaseTransitionPayload,
  ): Promise<string> {
    const phaseKey = `${projectId}:${newPhaseData.phaseId}`;
    const existingJobId = this.activeSchedules.get(phaseKey);
    let wasRescheduled = false;

    // Check if a job is already scheduled
    if (existingJobId) {
      const scheduledJob =
        this.schedulerService.getScheduledTransition(existingJobId);

      if (!scheduledJob) {
        this.logger.warn(
          `No scheduled job found for phase ${phaseKey}, skipping reschedule.`,
        );
        return existingJobId;
      }

      if (scheduledJob && scheduledJob.date && newPhaseData.date) {
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

      // Cancel the previous job
      this.cancelPhaseTransition(projectId, newPhaseData.phaseId);
    }

    // Schedule the new transition
    const newJobId = this.schedulePhaseTransition(newPhaseData);

    // Only log "rescheduled" if an existing job was actually rescheduled
    if (wasRescheduled) {
      this.logger.log(
        `Successfully rescheduled phase ${newPhaseData.phaseId} with new end time: ${newPhaseData.date}`,
      );
    }

    // Add an await to satisfy the linter
    await Promise.resolve();

    return newJobId;
  }

  async handlePhaseTransition(message: PhaseTransitionPayload): Promise<void> {
    this.logger.log(`Handling phase transition: ${JSON.stringify(message)}`);

    if (message.state === 'END') {
      const canceled = this.cancelPhaseTransition(
        message.projectId,
        message.phaseId,
      );
      if (canceled) {
        this.logger.log(
          `Removed job for phase ${message.phaseId} (project ${message.projectId}) from registry`,
        );
      }
    }

    // Future: Trigger challenge API update here

    return Promise.resolve();
  }

  /**
   * Handle challenge updates that might affect phase schedules
   */
  async handleChallengeUpdate(message: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(`Handling challenge update: ${JSON.stringify(message)}`);

    try {
      // Extract phaseId from message if available (for backward compatibility)
      // Cast to unknown first, then to Record to avoid type errors
      const anyMessage = message as unknown as Record<string, unknown>;
      const phaseId = anyMessage.phaseId as number | undefined;

      if (!phaseId) {
        this.logger.warn(
          `Skipping scheduling — challenge update missing phase ID.`,
        );
        return;
      }

      // Fetch phase details using the API service
      const phaseDetails = await this.challengeApiService.getPhaseDetails(
        message.projectId,
        phaseId,
      );

      if (!phaseDetails) {
        this.logger.warn(
          `Skipping scheduling — could not fetch phase details for project ${message.projectId}, phase ${phaseId}.`,
        );
        return;
      }

      const payload: PhaseTransitionPayload = {
        projectId: message.projectId,
        challengeId: message.challengeId, // Added to meet requirement #6
        phaseId: phaseId,
        phaseTypeName: phaseDetails.phaseTypeName,
        operator: message.operator,
        projectStatus: message.status,
        date: message.date || phaseDetails.date,
        state: 'END',
      };

      this.logger.log(
        `Scheduling updated phase: ${message.projectId}:${phaseId}`,
      );

      await this.reschedulePhaseTransition(message.projectId, payload);
    } catch (error) {
      this.logger.error(
        `Error handling challenge update: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Handle commands (manual operations)
   */
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

          // If phaseId is provided, cancel only that specific phase
          if (phaseId) {
            const canceled = this.cancelPhaseTransition(projectId, phaseId);
            if (canceled) {
              this.logger.log(
                `Canceled scheduled transition for phase ${projectId}:${phaseId}`,
              );
            } else {
              this.logger.warn(
                `No active schedule found for phase ${projectId}:${phaseId}`,
              );
            }
          } else {
            // Otherwise, cancel all phases for the project
            for (const key of this.activeSchedules.keys()) {
              if (key.startsWith(`${projectId}:`)) {
                const phaseIdFromKey = Number(key.split(':')[1]);
                this.cancelPhaseTransition(projectId, phaseIdFromKey);
              }
            }
          }
          break;

        case AUTOPILOT_COMMANDS.RESCHEDULE_PHASE: {
          if (!projectId || !phaseId || !date) {
            this.logger.warn(
              `${AUTOPILOT_COMMANDS.RESCHEDULE_PHASE}: missing required data (projectId, phaseId, or date)`,
            );
            return;
          }

          // Fetch phase type name using the API service
          void (async () => {
            try {
              const phaseTypeName =
                await this.challengeApiService.getPhaseTypeName(
                  projectId,
                  phaseId,
                );

              const payload: PhaseTransitionPayload = {
                projectId,
                phaseId,
                phaseTypeName,
                operator,
                state: 'END',
                projectStatus: 'IN_PROGRESS',
                date,
              };

              await this.reschedulePhaseTransition(projectId, payload);
            } catch (error) {
              this.logger.error(
                `Error in reschedule_phase command: ${error.message}`,
                error.stack,
              );
            }
          })();
          break;
        }

        default:
          this.logger.warn(`Unknown command received: ${command}`);
      }
    } catch (error) {
      this.logger.error(
        `Error handling command: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Get active schedules with business context
   * Returns the mapping of phase keys to job IDs
   */
  getActiveSchedules(): Map<string, string> {
    return new Map(this.activeSchedules);
  }

  /**
   * Get all scheduled transitions with enhanced info
   * Combines low-level scheduler data with business context
   */
  getAllScheduledTransitions(): {
    jobIds: string[];
    activeSchedules: Map<string, string>;
  } {
    return {
      jobIds: this.schedulerService.getAllScheduledTransitions(),
      activeSchedules: this.getActiveSchedules(),
    };
  }
}
