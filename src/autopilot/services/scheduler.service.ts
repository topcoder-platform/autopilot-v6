import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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
import { Job, Queue, RedisOptions, Worker } from 'bullmq';

const PHASE_QUEUE_NAME = 'autopilot-phase-transitions';
const PHASE_QUEUE_PREFIX = '{autopilot-phase-transitions}';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
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
  private finalizationRetryTimers = new Map<string, NodeJS.Timeout>();
  private finalizationAttempts = new Map<string, number>();
  private readonly finalizationRetryBaseDelayMs = 60_000;
  private readonly finalizationRetryMaxAttempts = 10;
  private readonly finalizationRetryMaxDelayMs = 10 * 60 * 1000;

  private redisConnection?: RedisOptions;
  private phaseQueue?: Queue<PhaseTransitionPayload>;
  private phaseQueueWorker?: Worker<PhaseTransitionPayload>;
  private initializationPromise?: Promise<void>;

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly challengeCompletionService: ChallengeCompletionService,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeBullQueue();
    }
    await this.initializationPromise;
  }

  private async initializeBullQueue(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.redisConnection = { url: redisUrl };

    this.phaseQueue = new Queue<PhaseTransitionPayload>(PHASE_QUEUE_NAME, {
      connection: this.redisConnection,
      prefix: PHASE_QUEUE_PREFIX,
    });

    this.phaseQueueWorker = new Worker<PhaseTransitionPayload>(
      PHASE_QUEUE_NAME,
      async (job) => await this.handlePhaseTransitionJob(job),
      {
        connection: this.redisConnection,
        concurrency: 1,
        prefix: PHASE_QUEUE_PREFIX,
      },
    );

    this.phaseQueueWorker.on('failed', (job, error) => {
      if (!job) {
        return;
      }
      this.logger.error(
        `BullMQ job ${job.id} failed for challenge ${job.data.challengeId}, phase ${job.data.phaseId}: ${error.message}`,
        error.stack,
      );
    });

    this.phaseQueueWorker.on('error', (error) => {
      this.logger.error(`BullMQ worker error: ${error.message}`, error.stack);
    });

    await this.phaseQueueWorker.waitUntilReady();
    this.logger.log(
      `BullMQ scheduler initialized using ${redisUrl} for queue ${PHASE_QUEUE_NAME}`,
    );
  }

  private async handlePhaseTransitionJob(
    job: Job<PhaseTransitionPayload>,
  ): Promise<void> {
    await this.runScheduledTransition(String(job.id), job.data);
  }

  async onModuleInit(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeBullQueue();
    }

    try {
      await this.initializationPromise;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to initialize BullMQ scheduler: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const disposables: Promise<void>[] = [];

    if (this.phaseQueueWorker) {
      disposables.push(this.phaseQueueWorker.close());
    }

    if (this.phaseQueue) {
      disposables.push(this.phaseQueue.close());
    }

    try {
      await Promise.all(disposables);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error while shutting down BullMQ resources: ${err.message}`,
        err.stack,
      );
    }

    for (const timeout of this.finalizationRetryTimers.values()) {
      clearTimeout(timeout);
    }
    this.finalizationRetryTimers.clear();
  }

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

  async schedulePhaseTransition(
    phaseData: PhaseTransitionPayload,
  ): Promise<string> {
    const { challengeId, phaseId, date: endTime } = phaseData;
    const jobId = `${challengeId}|${phaseId}`; // BullMQ rejects ':' in custom IDs, use pipe instead

    if (!endTime || endTime === '' || isNaN(new Date(endTime).getTime())) {
      this.logger.error(
        `Invalid or missing end time for job ${jobId}. Skipping schedule.`,
      );
      throw new Error(
        'Invalid or missing end time provided for phase transition',
      );
    }

    try {
      await this.ensureInitialized();

      const delayMs = Math.max(0, new Date(endTime).getTime() - Date.now());
      if (!this.phaseQueue) {
        throw new Error('Phase queue not initialized');
      }

      await this.phaseQueue.add('phase-transition', phaseData, {
        jobId,
        delay: delayMs,
        removeOnComplete: true,
        attempts: 1,
      });

      this.scheduledJobs.set(jobId, phaseData);
      this.logger.log(
        `Successfully scheduled job ${jobId} for ${endTime} with delay ${delayMs} ms`,
      );
      return jobId;
    } catch (error) {
      this.logger.error(
        `Failed to schedule phase transition for job ${jobId}`,
        error,
      );
      throw error;
    }
  }

  private async runScheduledTransition(
    jobId: string,
    phaseData: PhaseTransitionPayload,
  ): Promise<void> {
    try {
      // Before triggering the event, check if the phase still needs the transition
      const phaseDetails = await this.challengeApiService.getPhaseDetails(
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
    } catch (error) {
      this.logger.error(
        `Failed to trigger Kafka event for job ${jobId}`,
        error,
      );
    } finally {
      this.scheduledJobs.delete(jobId);
    }
  }

  async cancelScheduledTransition(jobId: string): Promise<boolean> {
    try {
      await this.ensureInitialized();

      if (!this.phaseQueue) {
        throw new Error('Phase queue not initialized');
      }

      const job = await this.phaseQueue.getJob(jobId);
      if (!job) {
        this.logger.warn(
          `No BullMQ job found for phase ${jobId}, skipping cancellation`,
        );
        return false;
      }

      await job.remove();
      this.scheduledJobs.delete(jobId);
      this.logger.log(`Canceled scheduled transition for phase ${jobId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error canceling scheduled transition ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
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
    const existingTimer = this.finalizationRetryTimers.get(challengeId);
    if (existingTimer) {
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
    const timer = setTimeout(() => {
      this.finalizationRetryTimers.delete(challengeId);
      void this.attemptChallengeFinalization(challengeId);
    }, delay);

    this.finalizationRetryTimers.set(challengeId, timer);
    this.logger.log(
      `Scheduled finalization retry ${attempt + 1} for challenge ${challengeId} in ${Math.round(delay / 1000)} second(s).`,
    );
  }

  private computeFinalizationDelay(attempt: number): number {
    const multiplier = Math.max(attempt, 1);
    const delay = this.finalizationRetryBaseDelayMs * multiplier;
    return Math.min(delay, this.finalizationRetryMaxDelayMs);
  }

  private clearFinalizationRetry(challengeId: string): void {
    const timer = this.finalizationRetryTimers.get(challengeId);
    if (timer) {
      clearTimeout(timer);
    }
    this.finalizationRetryTimers.delete(challengeId);
  }
}
