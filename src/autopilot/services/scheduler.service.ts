import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { KafkaService } from '../../kafka/kafka.service';
import {
  PhaseTransitionMessage,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';
import { KAFKA_TOPICS } from 'src/kafka/constants/topics';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private scheduledJobs = new Map<string, PhaseTransitionPayload>();

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private readonly kafkaService: KafkaService,
  ) {}

  schedulePhaseTransition(phaseData: PhaseTransitionPayload): string {
    const { projectId: projectId, phaseId, date: endTime } = phaseData;
    const jobId = `${projectId}:${phaseId}`;

    if (!endTime || endTime === '') {
      throw new Error('End time is required');
    }

    // Note: The check for past dates is now handled in AutopilotService
    // This allows us to process past dates immediately instead of throwing an error

    try {
      const timeout = setTimeout(
        () => {
          void (async () => {
            await this.triggerKafkaEvent(phaseData);
            if (this.schedulerRegistry.doesExist('timeout', jobId)) {
              this.schedulerRegistry.deleteTimeout(jobId);
              this.logger.log(
                `Removed job for phase ${jobId} from registry after successful execution`,
              );
            } else {
              this.logger.warn(
                `No timeout found for phase ${jobId}, skipping cleanup`,
              );
            }
            if (this.scheduledJobs.has(jobId)) {
              this.scheduledJobs.delete(jobId);
            }
          })();
        },
        Math.max(0, new Date(endTime).getTime() - Date.now()),
      ); // Ensure we don't use negative delays

      this.schedulerRegistry.addTimeout(jobId, timeout);
      this.scheduledJobs.set(jobId, phaseData);
      return jobId;
    } catch (error) {
      this.logger.error('Failed to schedule phase transition', error);
      throw error;
    }
  }

  cancelScheduledTransition(jobId: string): boolean {
    try {
      if (this.schedulerRegistry.doesExist('timeout', jobId)) {
        this.schedulerRegistry.deleteTimeout(jobId);
        this.logger.log(`Canceled scheduled transition for phase ${jobId}`);
        return true;
      } else {
        this.logger.warn(
          `No timeout found for phase ${jobId}, skipping cancellation`,
        );
        return false; // Return false when no job was found to cancel
      }
    } catch (error) {
      this.logger.error(
        `Error canceling scheduled transition: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  updateScheduledTransition(
    jobId: string,
    phaseData: PhaseTransitionPayload,
  ): string {
    const canceled = this.cancelScheduledTransition(jobId);
    if (!canceled) {
      throw new Error(`Failed to cancel existing job with ID ${jobId}`);
    }
    return this.schedulePhaseTransition(phaseData);
  }

  getAllScheduledTransitions(): string[] {
    return this.schedulerRegistry.getTimeouts();
  }

  getScheduledTransition(jobId: string): PhaseTransitionPayload | null {
    return this.scheduledJobs.get(jobId) || null;
  }

  private async triggerKafkaEvent(data: PhaseTransitionPayload) {
    const payload: PhaseTransitionPayload = {
      projectId: data.projectId,
      phaseId: data.phaseId,
      challengeId: data.challengeId, // Include challengeId in the payload
      phaseTypeName: data.phaseTypeName,
      state: 'END',
      operator: 'system',
      projectStatus: 'IN_PROGRESS',
      date: new Date().toISOString(),
    };

    try {
      const message: PhaseTransitionMessage = {
        topic: KAFKA_TOPICS.PHASE_TRANSITION,
        originator: 'autopilot-scheduler',
        timestamp: new Date().toISOString(),
        mimeType: 'application/json',
        payload,
      };
      await this.kafkaService.produce(KAFKA_TOPICS.PHASE_TRANSITION, message);
      this.logger.log(
        `Successfully sent transition event for challenge ${data.projectId}, phase ${data.phaseId}`,
      );
    } catch (err: any) {
      this.logger.error('Failed to send Kafka event', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        err: err.stack || err.message,
      });
    }
  }
}
