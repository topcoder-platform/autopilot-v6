import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { KafkaService } from '../../kafka/kafka.service';
import {
  PhaseTransitionMessage,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';

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

    const delay = new Date(endTime).getTime() - Date.now();
    if (delay <= 0) {
      throw new Error('Cannot schedule job in the past');
    }

    try {
      const timeout = setTimeout(() => {
        void (async () => {
          await this.triggerKafkaEvent(phaseData);
          if (this.schedulerRegistry.doesExist('timeout', jobId)) {
            this.schedulerRegistry.deleteTimeout(jobId);
            this.logger.log(`Canceled scheduled transition for phase ${jobId}`);
          } else {
            this.logger.warn(
              `No timeout found for phase ${jobId}, skipping cancellation`,
            );
          }
          if (this.scheduledJobs.has(jobId)) {
            this.scheduledJobs.delete(jobId);
          }
        })();
      }, delay);

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
      } else {
        this.logger.warn(
          `No timeout found for phase ${jobId}, skipping cancellation`,
        );
      }

      return true;
    } catch {
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

  private async triggerKafkaEvent(data: PhaseTransitionPayload) {
    const payload: PhaseTransitionPayload = {
      projectId: data.projectId,
      phaseId: data.phaseId,
      phaseTypeName: data.phaseTypeName,
      state: 'END',
      operator: 'system',
      projectStatus: 'IN_PROGRESS',
      date: new Date().toISOString(),
    };

    try {
      const message: PhaseTransitionMessage = {
        topic: 'autopilot.phase.transition',
        originator: 'autopilot-scheduler',
        timestamp: new Date().toISOString(),
        mimeType: 'application/json',
        payload,
      };
      await this.kafkaService.produce('autopilot.phase.transition', message);
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

  getScheduledTransition(jobId: string): PhaseTransitionPayload | null {
    return this.scheduledJobs.get(jobId) || null;
  }
}
