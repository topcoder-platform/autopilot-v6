import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { KafkaService } from '../../kafka/kafka.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import {
  PhaseTransitionMessage,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';
import { KAFKA_TOPICS } from '../../kafka/constants/topics';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private scheduledJobs = new Map<string, PhaseTransitionPayload>();

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private readonly kafkaService: KafkaService,
    private readonly challengeApiService: ChallengeApiService,
  ) {}

  schedulePhaseTransition(phaseData: PhaseTransitionPayload): string {
    const { challengeId, phaseId, date: endTime } = phaseData;
    const jobId = `${challengeId}:${phaseId}`;

    if (!endTime || endTime === '' || isNaN(new Date(endTime).getTime())) {
      this.logger.error(
        `Invalid or missing end time for job ${jobId}. Skipping schedule.`,
      );
      throw new Error(
        'Invalid or missing end time provided for phase transition',
      );
    }

    try {
      const timeoutDuration = new Date(endTime).getTime() - Date.now();

      // Corrected: Ensure the timeout is never negative to prevent the TimeoutNegativeWarning.
      // If the time is in the past, it will execute on the next tick (timeout of 0).
      const timeout = setTimeout(
        () => {
          void (async () => {
            try {
              await this.triggerKafkaEvent(phaseData);

              // Call advancePhase method when phase transition is triggered
              await this.advancePhase(phaseData);
            } catch (e) {
              this.logger.error(
                `Failed to trigger Kafka event for job ${jobId}`,
                e,
              );
            } finally {
              if (this.schedulerRegistry.doesExist('timeout', jobId)) {
                this.schedulerRegistry.deleteTimeout(jobId);
                this.logger.log(
                  `Removed job for phase ${jobId} from registry after execution`,
                );
              }
              this.scheduledJobs.delete(jobId);
            }
          })();
        },
        Math.max(0, timeoutDuration),
      );

      this.schedulerRegistry.addTimeout(jobId, timeout);
      this.scheduledJobs.set(jobId, phaseData);
      this.logger.log(`Successfully scheduled job ${jobId} for ${endTime}`);
      return jobId;
    } catch (error) {
      this.logger.error(
        `Failed to schedule phase transition for job ${jobId}`,
        error,
      );
      throw error;
    }
  }

  cancelScheduledTransition(jobId: string): boolean {
    try {
      if (this.schedulerRegistry.doesExist('timeout', jobId)) {
        this.schedulerRegistry.deleteTimeout(jobId);
        this.scheduledJobs.delete(jobId);
        this.logger.log(`Canceled scheduled transition for phase ${jobId}`);
        return true;
      } else {
        this.logger.warn(
          `No timeout found for phase ${jobId}, skipping cancellation`,
        );
        return false;
      }
    } catch (error) {
      this.logger.error(
        `Error canceling scheduled transition: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  getAllScheduledTransitions(): string[] {
    return Array.from(this.scheduledJobs.keys());
  }

  getAllScheduledTransitionsWithData(): Map<string, PhaseTransitionPayload> {
    return this.scheduledJobs;
  }

  getScheduledTransition(jobId: string): PhaseTransitionPayload | undefined {
    return this.scheduledJobs.get(jobId);
  }

  public async triggerKafkaEvent(data: PhaseTransitionPayload) {
    const payload: PhaseTransitionPayload = {
      ...data,
      state: 'END',
      operator: 'system-scheduler',
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
        `Successfully sent transition event for challenge ${data.challengeId}, phase ${data.phaseId}`,
      );
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error('Failed to send Kafka event', {
        err: err.stack || err.message,
      });
      throw err;
    }
  }

  public async advancePhase(data: PhaseTransitionPayload): Promise<void> {
    try {
      this.logger.log(
        `Advancing phase ${data.phaseId} for challenge ${data.challengeId}`,
      );

      const result = await this.challengeApiService.advancePhase(
        data.challengeId,
        data.phaseId,
        'close', // Assuming 'close' operation when phase ends
      );

      if (result.success) {
        this.logger.log(
          `Successfully advanced phase ${data.phaseId} for challenge ${data.challengeId}: ${result.message}`,
        );
      } else {
        this.logger.error(
          `Failed to advance phase ${data.phaseId} for challenge ${data.challengeId}: ${result.message}`,
        );
      }
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(
        `Error advancing phase ${data.phaseId} for challenge ${data.challengeId}`,
        {
          err: err.stack || err.message,
        },
      );
    }
  }
}
