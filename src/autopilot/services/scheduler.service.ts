import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { KafkaService } from '../../kafka/kafka.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ChallengeCompletionService } from './challenge-completion.service';
import {
  PhaseTransitionMessage,
  PhaseTransitionPayload,
  AutopilotOperator,
} from '../interfaces/autopilot.interface';
import { KAFKA_TOPICS } from '../../kafka/constants/topics';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private scheduledJobs = new Map<string, PhaseTransitionPayload>();
  private phaseChainCallback:
    | ((
        challengeId: string,
        projectId: number,
        projectStatus: string,
        nextPhases: any[],
      ) => Promise<void> | void)
    | null = null;
  private finalizationRetryJobs = new Map<string, string>();
  private finalizationAttempts = new Map<string, number>();
  private readonly finalizationRetryBaseDelayMs = 60_000;
  private readonly finalizationRetryMaxAttempts = 10;
  private readonly finalizationRetryMaxDelayMs = 10 * 60 * 1000;

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private readonly kafkaService: KafkaService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly challengeCompletionService: ChallengeCompletionService,
  ) {}

  setPhaseChainCallback(
    callback: (
      challengeId: string,
      projectId: number,
      projectStatus: string,
      nextPhases: any[],
    ) => Promise<void> | void,
  ): void {
    this.phaseChainCallback = callback;
  }

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
              // Before triggering the event, check if the phase still needs the transition
              const phaseDetails =
                await this.challengeApiService.getPhaseDetails(
                  phaseData.challengeId,
                  phaseData.phaseId,
                );

              if (!phaseDetails) {
                this.logger.warn(
                  `Phase ${phaseData.phaseId} not found in challenge ${phaseData.challengeId}, skipping scheduled transition`,
                );
                return;
              }

              // Check if the phase is in the expected state for the transition
              if (phaseData.state === 'END' && !phaseDetails.isOpen) {
                this.logger.warn(
                  `Scheduled END transition for phase ${phaseData.phaseId} but it's already closed, skipping`,
                );
                return;
              }

              if (phaseData.state === 'START' && phaseDetails.isOpen) {
                this.logger.warn(
                  `Scheduled START transition for phase ${phaseData.phaseId} but it's already open, skipping`,
                );
                return;
              }

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
    // Validate phase state before sending the event
    const phaseDetails = await this.challengeApiService.getPhaseDetails(
      data.challengeId,
      data.phaseId,
    );

    if (!phaseDetails) {
      this.logger.error(
        `Cannot trigger event: Phase ${data.phaseId} not found in challenge ${data.challengeId}`,
      );
      return;
    }

    // Check if the phase is in the expected state
    if (data.state === 'END' && !phaseDetails.isOpen) {
      this.logger.warn(
        `Skipping END event for phase ${data.phaseId} - it's already closed`,
      );
      return;
    }

    if (data.state === 'START' && phaseDetails.isOpen) {
      this.logger.warn(
        `Skipping START event for phase ${data.phaseId} - it's already open`,
      );
      return;
    }

    const payload: PhaseTransitionPayload = {
      ...data,
      state: data.state || 'END', // Default to END if not specified
      operator: AutopilotOperator.SYSTEM_SCHEDULER,
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
        `Successfully sent ${payload.state} transition event for challenge ${data.challengeId}, phase ${data.phaseId}`,
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

      // Check current phase state to determine the correct operation
      const phaseDetails = await this.challengeApiService.getPhaseDetails(
        data.challengeId,
        data.phaseId,
      );

      if (!phaseDetails) {
        this.logger.error(
          `Phase ${data.phaseId} not found in challenge ${data.challengeId}`,
        );
        return;
      }

      // Determine operation based on transition state and current phase state
      let operation: 'open' | 'close';

      if (data.state === 'START') {
        operation = 'open';
      } else if (data.state === 'END') {
        operation = 'close';
      } else {
        // Fallback: determine based on current phase state
        operation = phaseDetails.isOpen ? 'close' : 'open';
      }

      // Validate that the operation makes sense
      if (operation === 'open' && phaseDetails.isOpen) {
        this.logger.warn(
          `Phase ${data.phaseId} is already open, skipping open operation`,
        );
        return;
      }

      if (operation === 'close' && !phaseDetails.isOpen) {
        this.logger.warn(
          `Phase ${data.phaseId} is already closed, skipping close operation`,
        );
        return;
      }

      this.logger.log(
        `Phase ${data.phaseId} is currently ${phaseDetails.isOpen ? 'open' : 'closed'}, will ${operation} it`,
      );

      const result = await this.challengeApiService.advancePhase(
        data.challengeId,
        data.phaseId,
        operation,
      );

      if (result.success) {
        this.logger.log(
          `Successfully advanced phase ${data.phaseId} for challenge ${data.challengeId}: ${result.message}`,
        );

        if (operation === 'open') {
          try {
            await this.phaseReviewService.handlePhaseOpened(
              data.challengeId,
              data.phaseId,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to create pending reviews for phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
              err.stack,
            );
          }
        }

        if (operation === 'close') {
          try {
            let phases = result.updatedPhases;
            if (!phases || !phases.length) {
              phases = await this.challengeApiService.getChallengePhases(
                data.challengeId,
              );
            }

            const hasOpenPhases = phases?.some((phase) => phase.isOpen) ?? true;
            const hasIncompletePhases =
              phases?.some((phase) => !phase.actualEndDate) ?? true;
            const hasNextPhases = Boolean(result.next?.phases?.length);

            if (!hasOpenPhases && !hasNextPhases && !hasIncompletePhases) {
              await this.attemptChallengeFinalization(data.challengeId);
            } else {
              const pendingCount = phases?.reduce((pending, phase) => {
                return pending + (phase.isOpen || !phase.actualEndDate ? 1 : 0);
              }, 0);
              this.logger.debug?.(
                `Challenge ${data.challengeId} not ready for completion after closing phase ${data.phaseId}. Pending phases: ${pendingCount ?? 'unknown'}, next phases: ${result.next?.phases?.length ?? 0}.`,
              );
            }
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to finalize challenge ${data.challengeId} after closing phase ${data.phaseId}: ${err.message}`,
              err.stack,
            );
          }
        }

        // Handle phase transition chain - open and schedule next phases if they exist
        if (
          result.next?.operation === 'open' &&
          result.next.phases &&
          result.next.phases.length > 0
        ) {
          try {
            if (this.phaseChainCallback) {
              this.logger.log(
                `[PHASE CHAIN] Triggering phase chain callback for challenge ${data.challengeId} with ${result.next.phases.length} next phases`,
              );
              const callbackResult = this.phaseChainCallback(
                data.challengeId,
                data.projectId,
                data.projectStatus,
                result.next.phases,
              );

              // Handle both sync and async callbacks
              if (callbackResult instanceof Promise) {
                await callbackResult;
              }
            } else {
              this.logger.warn(
                `[PHASE CHAIN] Phase chain callback not set, cannot open and schedule next phases for challenge ${data.challengeId}`,
              );
            }
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `[PHASE CHAIN] Error in phase chain callback for challenge ${data.challengeId}: ${err.message}`,
              err.stack,
            );
          }
        } else {
          this.logger.log(
            `[PHASE CHAIN] No next phases to open and schedule for challenge ${data.challengeId}`,
          );
        }
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

  private async attemptChallengeFinalization(
    challengeId: string,
  ): Promise<void> {
    const attempt = (this.finalizationAttempts.get(challengeId) ?? 0) + 1;
    this.finalizationAttempts.set(challengeId, attempt);

    try {
      const completed =
        await this.challengeCompletionService.finalizeChallenge(challengeId);

      if (completed) {
        this.logger.log(
          `Successfully finalized challenge ${challengeId} after ${attempt} attempt(s).`,
        );
        this.clearFinalizationRetry(challengeId);
        this.finalizationAttempts.delete(challengeId);
        return;
      }

      this.logger.log(
        `Final review scores not yet available for challenge ${challengeId}; scheduling retry attempt ${attempt + 1}.`,
      );
      this.scheduleFinalizationRetry(challengeId, attempt);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Attempt ${attempt} to finalize challenge ${challengeId} failed: ${err.message}`,
        err.stack,
      );
      this.scheduleFinalizationRetry(challengeId, attempt);
    }
  }

  private scheduleFinalizationRetry(
    challengeId: string,
    attempt: number,
  ): void {
    const existingJobId = this.finalizationRetryJobs.get(challengeId);
    if (
      existingJobId &&
      this.schedulerRegistry.doesExist('timeout', existingJobId)
    ) {
      this.logger.debug?.(
        `Finalization retry already scheduled for challenge ${challengeId}; skipping duplicate schedule.`,
      );
      return;
    }

    if (attempt >= this.finalizationRetryMaxAttempts) {
      this.logger.error(
        `Reached maximum finalization attempts (${this.finalizationRetryMaxAttempts}) for challenge ${challengeId}. Manual intervention required to resolve winners.`,
      );
      this.clearFinalizationRetry(challengeId);
      this.finalizationAttempts.delete(challengeId);
      return;
    }

    const delay = this.computeFinalizationDelay(attempt);
    const jobId = `challenge-finalize:${challengeId}:${attempt + 1}`;

    const timeout = setTimeout(() => {
      try {
        if (this.schedulerRegistry.doesExist('timeout', jobId)) {
          this.schedulerRegistry.deleteTimeout(jobId);
        }
      } catch (cleanupError) {
        this.logger.error(
          `Failed to clean up finalization retry job ${jobId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      } finally {
        this.finalizationRetryJobs.delete(challengeId);
      }

      void this.attemptChallengeFinalization(challengeId);
    }, delay);

    try {
      this.schedulerRegistry.addTimeout(jobId, timeout);
      this.finalizationRetryJobs.set(challengeId, jobId);
      this.logger.log(
        `Scheduled finalization retry ${attempt + 1} for challenge ${challengeId} in ${Math.round(delay / 1000)} second(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to schedule finalization retry for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      clearTimeout(timeout);
    }
  }

  private computeFinalizationDelay(attempt: number): number {
    const multiplier = Math.max(attempt, 1);
    const delay = this.finalizationRetryBaseDelayMs * multiplier;
    return Math.min(delay, this.finalizationRetryMaxDelayMs);
  }

  private clearFinalizationRetry(challengeId: string): void {
    const jobId = this.finalizationRetryJobs.get(challengeId);
    if (jobId && this.schedulerRegistry.doesExist('timeout', jobId)) {
      this.schedulerRegistry.deleteTimeout(jobId);
    }
    this.finalizationRetryJobs.delete(challengeId);
  }
}
