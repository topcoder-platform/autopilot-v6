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

  private activeSchedules = new Map<string, string>();

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
  ) {}

  schedulePhaseTransition(phaseData: PhaseTransitionPayload): string {
    try {
      const phaseKey = `${phaseData.projectId}:${phaseData.phaseId}`;

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

  cancelPhaseTransition(projectId: number, phaseId: string): boolean {
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

  reschedulePhaseTransition(
    projectId: number,
    newPhaseData: PhaseTransitionPayload,
  ): string {
    const phaseKey = `${projectId}:${newPhaseData.phaseId}`;
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

    if (message.state === 'END') {
      const canceled = this.cancelPhaseTransition(
        message.projectId,
        message.phaseId,
      );
      if (canceled) {
        this.logger.log(
          `Cleaned up job for phase ${message.phaseId} (project ${message.projectId}) from registry after consuming event.`,
        );
      }
    }
  }

  async handleNewChallenge(challenge: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(
      `Handling new challenge creation: ${JSON.stringify(challenge)}`,
    );
    try {
      // Refactored: Use getActiveChallenge as required
      const challengeDetails =
        await this.challengeApiService.getActiveChallenge(
          challenge.challengeId,
        );

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Challenge ${challenge.challengeId} has no phases to schedule.`,
        );
        return;
      }

      for (const phase of challengeDetails.phases) {
        if (!phase.scheduledEndDate) {
          this.logger.warn(
            `Phase ${phase.id} for new challenge ${challenge.challengeId} has no scheduled end date. Skipping.`,
          );
          continue;
        }
        const phaseData: PhaseTransitionPayload = {
          projectId: challengeDetails.projectId,
          challengeId: challengeDetails.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          state: 'END',
          operator: 'system-new-challenge',
          projectStatus: challengeDetails.status,
          date: phase.scheduledEndDate,
        };
        this.schedulePhaseTransition(phaseData);
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling new challenge creation for id ${challenge.challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleChallengeUpdate(message: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(`Handling challenge update: ${JSON.stringify(message)}`);

    try {
      // Refactored: Use getActiveChallenge as required
      const challengeDetails =
        await this.challengeApiService.getActiveChallenge(message.challengeId);

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Updated challenge ${message.challengeId} has no phases to process.`,
        );
        return;
      }

      for (const phase of challengeDetails.phases) {
        if (!phase.scheduledEndDate) continue;

        const payload: PhaseTransitionPayload = {
          projectId: challengeDetails.projectId,
          challengeId: challengeDetails.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          operator: message.operator,
          projectStatus: challengeDetails.status,
          date: phase.scheduledEndDate,
          state: 'END',
        };

        this.logger.log(
          `Rescheduling updated phase from notification: ${challengeDetails.projectId}:${phase.id}`,
        );
        this.reschedulePhaseTransition(challengeDetails.projectId, payload);
      }
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
            for (const key of this.activeSchedules.keys()) {
              if (key.startsWith(`${projectId}:`)) {
                const phaseIdFromKey = key.split(':')[1];
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

          void (async () => {
            try {
              const challenges =
                await this.challengeApiService.getAllActiveChallenges({
                  status: 'ACTIVE',
                });
              const associatedChallenge = challenges.find(
                (c) => c.projectId === projectId,
              );

              if (!associatedChallenge) {
                this.logger.error(
                  `Could not find an active challenge with projectId ${projectId} to reschedule.`,
                );
                return;
              }

              const phaseTypeName =
                await this.challengeApiService.getPhaseTypeName(
                  associatedChallenge.id,
                  phaseId,
                );

              const payload: PhaseTransitionPayload = {
                projectId,
                phaseId,
                challengeId: associatedChallenge.id,
                phaseTypeName,
                operator,
                state: 'END',
                projectStatus: 'IN_PROGRESS', // Assuming status
                date,
              };

              this.reschedulePhaseTransition(projectId, payload);
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
}
