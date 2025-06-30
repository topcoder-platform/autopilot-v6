/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import {
  PhaseTransitionPayload,
  ChallengeUpdatePayload,
  CommandPayload,
} from '../interfaces/autopilot.interface';

@Injectable()
export class AutopilotService {
  private readonly logger = new Logger(AutopilotService.name);

  // Store active schedules for tracking purposes
  private activeSchedules = new Map<string, string>();

  constructor(private readonly schedulerService: SchedulerService) {}

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
  reschedulePhaseTransition(
    projectId: number,
    newPhaseData: PhaseTransitionPayload,
  ): string {
    const phaseKey = `${projectId}:${newPhaseData.phaseId}`;
    const existingJobId = this.activeSchedules.get(phaseKey);

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
      }

      // Cancel the previous job
      this.cancelPhaseTransition(projectId, newPhaseData.phaseId);
    }

    // Schedule the new transition
    const newJobId = this.schedulePhaseTransition(newPhaseData);

    this.logger.log(
      `Successfully rescheduled phase ${newPhaseData.phaseId} with new end time: ${newPhaseData.date}`,
    );

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
          `Canceled scheduled transition for phase ${message.phaseId} (project ${message.projectId})`,
        );
      }
    }

    // Future: Trigger challenge API update here

    return Promise.resolve();
  }

  /**
   * Handle challenge updates that might affect phase schedules
   */
  handleChallengeUpdate(message: ChallengeUpdatePayload): void {
    this.logger.log(`Handling challenge update: ${JSON.stringify(message)}`);

    if (!message.phaseId || !message.date) {
      this.logger.warn(
        `Skipping scheduling — challenge update missing required phase data.`,
      );
      return;
    }

    const payload: PhaseTransitionPayload = {
      projectId: message.projectId,
      phaseId: message.phaseId,
      phaseTypeName: message.phaseTypeName || 'UNKNOWN', // placeholder
      operator: message.operator,
      projectStatus: message.status,
      date: message.date,
      state: 'END',
    };

    this.logger.log(
      `Scheduling updated phase: ${message.projectId}:${message.phaseId}`,
    );

    this.reschedulePhaseTransition(message.projectId, payload);
  }

  /**
   * Handle commands (manual operations)
   */
  handleCommand(message: CommandPayload): void {
    const { command, operator, projectId, date, phaseId } = message;

    this.logger.log(`[COMMAND RECEIVED] ${command} from ${operator}`);

    try {
      switch (command.toLowerCase()) {
        case 'cancel_schedule':
          if (!projectId) {
            this.logger.warn('cancel_schedule: missing projectId');
            return;
          }

          for (const key of this.activeSchedules.keys()) {
            if (key.startsWith(`${projectId}:`)) {
              this.cancelPhaseTransition(projectId, Number(key.split(':')[1]));
            }
          }
          break;

        case 'reschedule_phase': {
          if (!projectId || !phaseId || !date) {
            this.logger.warn(
              `reschedule_phase: missing required data (projectId, phaseId, or date)`,
            );
            return;
          }

          const payload: PhaseTransitionPayload = {
            projectId,
            phaseId,
            phaseTypeName: 'UNKNOWN',
            operator,
            state: 'END',
            projectStatus: 'IN_PROGRESS',
            date,
          };

          this.reschedulePhaseTransition(projectId, payload);
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
