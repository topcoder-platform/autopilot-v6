import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { ChallengeStatusEnum } from '@prisma/client';
import { ReviewService } from '../../review/review.service';
import {
  POST_MORTEM_PHASE_NAME,
  REGISTRATION_PHASE_NAME,
  REVIEW_PHASE_NAMES,
  SUBMISSION_PHASE_NAME,
  TOPGEAR_SUBMISSION_PHASE_NAME,
} from '../constants/review.constants';
import { ResourcesService } from '../../resources/resources.service';
import { isTopgearTaskChallenge } from '../constants/challenge.constants';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';

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
  private readonly reviewCloseRetryAttempts = new Map<string, number>();
  private readonly reviewCloseRetryBaseDelayMs = 10 * 60 * 1000;
  private readonly reviewCloseRetryMaxDelayMs = 60 * 60 * 1000;
  private readonly registrationCloseRetryAttempts = new Map<string, number>();
  private readonly registrationCloseRetryBaseDelayMs = 5 * 60 * 1000;
  private readonly registrationCloseRetryMaxDelayMs = 30 * 60 * 1000;
  private readonly appealsCloseRetryAttempts = new Map<string, number>();
  private readonly appealsCloseRetryBaseDelayMs = 10 * 60 * 1000;
  private readonly appealsCloseRetryMaxDelayMs = 60 * 60 * 1000;
  private readonly submitterRoles: string[];
  private readonly postMortemRoles: string[];
  private readonly postMortemScorecardId: string | null;
  private readonly postMortemDurationHours: number;
  private readonly topgearPostMortemScorecardId: string | null;
  private readonly appealsPhaseNames: Set<string>;
  private readonly appealsResponsePhaseNames: Set<string>;

  private redisConnection?: RedisOptions;
  private phaseQueue?: Queue<PhaseTransitionPayload>;
  private phaseQueueWorker?: Worker<PhaseTransitionPayload>;
  private initializationPromise?: Promise<void>;

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly challengeCompletionService: ChallengeCompletionService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
  ) {
    this.submitterRoles = this.getStringArray('autopilot.submitterRoles', [
      'Submitter',
    ]);
    this.postMortemRoles = this.getStringArray('autopilot.postMortemRoles', [
      'Reviewer',
      'Copilot',
    ]);
    this.postMortemScorecardId =
      this.configService.get<string | null>(
        'autopilot.postMortemScorecardId',
      ) ?? null;
    this.topgearPostMortemScorecardId =
      this.configService.get<string | null>(
        'autopilot.topgearPostMortemScorecardId',
      ) ?? null;
    this.postMortemDurationHours =
      this.configService.get<number>('autopilot.postMortemDurationHours') ?? 72;
    this.appealsPhaseNames = new Set(
      this.getStringArray('autopilot.appealsPhaseNames', ['Appeals']),
    );
    this.appealsResponsePhaseNames = new Set(
      this.getStringArray('autopilot.appealsResponsePhaseNames', [
        'Appeals Response',
      ]),
    );
  }

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
    const jobId = this.buildJobId(challengeId, phaseId); // BullMQ rejects ':' in custom IDs, use pipe instead

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

  buildJobId(challengeId: string, phaseId: string): string {
    return `${challengeId}|${phaseId}`;
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

      const phaseName = phaseDetails.name;
      const isTopgearSubmissionPhase =
        phaseName === TOPGEAR_SUBMISSION_PHASE_NAME;
      const isSchedulerInitiated = this.isSchedulerInitiatedOperator(
        data.operator,
      );
      const isAppealsPhase =
        this.isAppealsPhaseName(phaseName) ||
        this.isAppealsPhaseName(data.phaseTypeName);
      const isAppealsResponsePhase =
        this.isAppealsResponsePhaseName(phaseName) ||
        this.isAppealsResponsePhaseName(data.phaseTypeName);
      const isAppealsRelatedPhase =
        isAppealsPhase || isAppealsResponsePhase;

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

      const isReviewPhase =
        REVIEW_PHASE_NAMES.has(phaseName) ||
        REVIEW_PHASE_NAMES.has(data.phaseTypeName);

      if (operation === 'close' && phaseName === REGISTRATION_PHASE_NAME) {
        try {
          const hasSubmitter = await this.resourcesService.hasSubmitterResource(
            data.challengeId,
            this.submitterRoles,
          );

          if (!hasSubmitter) {
            await this.deferRegistrationPhaseClosure(data);
            return;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[REGISTRATION] Failed to verify submitter resources for challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );
          await this.deferRegistrationPhaseClosure(data);
          return;
        }
      }

      if (operation === 'close' && isReviewPhase) {
        try {
          const pendingReviews = await this.reviewService.getPendingReviewCount(
            data.phaseId,
            data.challengeId,
          );

          if (pendingReviews > 0) {
            await this.deferReviewPhaseClosure(data, pendingReviews);
            return;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[REVIEW LATE] Unable to verify pending reviews for phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );

          await this.deferReviewPhaseClosure(data);
          return;
        }
      }

      if (
        operation === 'close' &&
        isTopgearSubmissionPhase &&
        isSchedulerInitiated
      ) {
        const handled = await this.handleTopgearSubmissionLate(
          data,
          phaseDetails,
        );
        if (handled) {
          return;
        }
      }

      if (operation === 'close' && isAppealsResponsePhase) {
        try {
          const pendingAppeals =
            await this.reviewService.getPendingAppealCount(data.challengeId);

          if (pendingAppeals > 0) {
            await this.deferAppealsPhaseClosure(data, pendingAppeals);
            return;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[APPEALS LATE] Unable to verify pending appeals for challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );

          await this.deferAppealsPhaseClosure(data);
          return;
        }
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

        let skipPhaseChain = false;
        let skipFinalization = false;

        if (operation === 'close' && isReviewPhase) {
          this.reviewCloseRetryAttempts.delete(
            this.buildReviewPhaseKey(data.challengeId, data.phaseId),
          );
        }

        if (operation === 'close' && isAppealsRelatedPhase) {
          this.appealsCloseRetryAttempts.delete(
            this.buildAppealsPhaseKey(data.challengeId, data.phaseId),
          );
        }

        if (operation === 'close' && phaseName === REGISTRATION_PHASE_NAME) {
          this.registrationCloseRetryAttempts.delete(
            this.buildRegistrationPhaseKey(data.challengeId, data.phaseId),
          );
        }

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
          if (phaseName === SUBMISSION_PHASE_NAME) {
            try {
              const handled = await this.handleSubmissionPhaseClosed(data);
              if (handled) {
                skipPhaseChain = true;
                skipFinalization = true;
              }
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[ZERO SUBMISSIONS] Unable to process post-submission workflow for challenge ${data.challengeId}: ${err.message}`,
                err.stack,
              );
            }
          } else if (phaseName === POST_MORTEM_PHASE_NAME) {
            try {
              await this.handlePostMortemPhaseClosed(data);
              skipFinalization = true;
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[ZERO SUBMISSIONS] Failed to cancel challenge ${data.challengeId} after post-mortem closure: ${err.message}`,
                err.stack,
              );
            }
          }

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

            if (
              !skipFinalization &&
              !hasOpenPhases &&
              !hasNextPhases &&
              !hasIncompletePhases
            ) {
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
          !skipPhaseChain &&
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
        } else if (!skipPhaseChain) {
          this.logger.log(
            `[PHASE CHAIN] No next phases to open and schedule for challenge ${data.challengeId}`,
          );
        } else {
          this.logger.log(
            `[PHASE CHAIN] Skipped automatic phase chaining for challenge ${data.challengeId} due to zero-submission workflow.`,
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

  private isSchedulerInitiatedOperator(
    operator?: AutopilotOperator | string,
  ): boolean {
    if (!operator) {
      return false;
    }

    const candidate = operator.toString().toLowerCase();
    return (
      candidate === AutopilotOperator.SYSTEM_SCHEDULER ||
      candidate === AutopilotOperator.SYSTEM_PHASE_CHAIN
    );
  }

  private async handleTopgearSubmissionLate(
    data: PhaseTransitionPayload,
    phase: IPhase,
  ): Promise<boolean> {
    try {
      const challenge =
        await this.challengeApiService.getChallengeById(data.challengeId);

      if (!isTopgearTaskChallenge(challenge.type)) {
        return false;
      }

      this.logger.log(
        `[TOPGEAR] Keeping submission phase ${phase.id} open for challenge ${data.challengeId}; awaiting passing submission.`,
      );

      const submissionCount = await this.reviewService.getActiveSubmissionCount(
        data.challengeId,
      );

      if (submissionCount === 0) {
        await this.ensureTopgearPostMortemReview(challenge);
      }

      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[TOPGEAR] Failed to defer submission closure for challenge ${data.challengeId}, phase ${data.phaseId}: ${err.message}`,
        err.stack,
      );
      return true;
    }
  }

  private async ensureTopgearPostMortemReview(
    challenge: IChallenge,
  ): Promise<void> {
    if (!this.topgearPostMortemScorecardId) {
      this.logger.warn(
        `[TOPGEAR] topgearPostMortemScorecardId is not configured; unable to create creator review for challenge ${challenge.id}.`,
      );
      return;
    }

    const postMortemPhase =
      challenge.phases?.find((phase) => phase.name === POST_MORTEM_PHASE_NAME) ??
      null;

    if (!postMortemPhase) {
      this.logger.warn(
        `[TOPGEAR] Post-Mortem phase not found on challenge ${challenge.id}; creator review cannot be created.`,
      );
      return;
    }

    const creatorHandle = challenge.createdBy?.trim();
    if (!creatorHandle) {
      this.logger.warn(
        `[TOPGEAR] Challenge ${challenge.id} missing creator handle; post-mortem review not created.`,
      );
      return;
    }

    try {
      const creatorResource = await this.resourcesService.getResourceByMemberHandle(
        challenge.id,
        creatorHandle,
      );

      if (!creatorResource) {
        this.logger.warn(
          `[TOPGEAR] Unable to locate resource for creator ${creatorHandle} on challenge ${challenge.id}; post-mortem review not created.`,
        );
        return;
      }

      const created = await this.reviewService.createPendingReview(
        null,
        creatorResource.id,
        postMortemPhase.id,
        this.topgearPostMortemScorecardId,
        challenge.id,
      );

      if (created) {
        this.logger.log(
          `[TOPGEAR] Created post-mortem review for challenge ${challenge.id} assigned to creator ${creatorHandle}.`,
        );
      } else {
        this.logger.debug?.(
          `[TOPGEAR] Post-mortem review already exists for challenge ${challenge.id}, creator ${creatorHandle}.`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[TOPGEAR] Failed to create post-mortem review for challenge ${challenge.id}: ${err.message}`,
        err.stack,
      );
    }
  }

  private async handleSubmissionPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<boolean> {
    try {
      const submissionCount = await this.reviewService.getActiveSubmissionCount(
        data.challengeId,
      );

      if (submissionCount > 0) {
        return false;
      }

      this.logger.log(
        `[ZERO SUBMISSIONS] No active submissions found for challenge ${data.challengeId}; transitioning to Post-Mortem phase.`,
      );

      const postMortemPhase =
        await this.challengeApiService.createPostMortemPhase(
          data.challengeId,
          data.phaseId,
          this.postMortemDurationHours,
        );

      await this.createPostMortemPendingReviews(
        data.challengeId,
        postMortemPhase.id,
      );

      if (!postMortemPhase.scheduledEndDate) {
        this.logger.warn(
          `[ZERO SUBMISSIONS] Created Post-Mortem phase ${postMortemPhase.id} for challenge ${data.challengeId} without a scheduled end date. Manual intervention required to close the phase.`,
        );
        return true;
      }

      const payload: PhaseTransitionPayload = {
        projectId: data.projectId,
        challengeId: data.challengeId,
        phaseId: postMortemPhase.id,
        phaseTypeName: postMortemPhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
        projectStatus: data.projectStatus,
        date: postMortemPhase.scheduledEndDate,
      };

      await this.schedulePhaseTransition(payload);
      this.logger.log(
        `[ZERO SUBMISSIONS] Scheduled Post-Mortem phase ${postMortemPhase.id} closure for challenge ${data.challengeId} at ${postMortemPhase.scheduledEndDate}.`,
      );

      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[ZERO SUBMISSIONS] Failed to prepare Post-Mortem workflow for challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async createPostMortemPendingReviews(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    if (!this.postMortemScorecardId) {
      this.logger.warn(
        `[ZERO SUBMISSIONS] Post-mortem scorecard ID is not configured; skipping review creation for challenge ${challengeId}.`,
      );
      return;
    }

    try {
      const resources = await this.resourcesService.getResourcesByRoleNames(
        challengeId,
        this.postMortemRoles,
      );

      if (!resources.length) {
        this.logger.log(
          `[ZERO SUBMISSIONS] No resources found for post-mortem roles on challenge ${challengeId}; skipping review creation.`,
        );
        return;
      }

      let createdCount = 0;
      for (const resource of resources) {
        try {
          const created = await this.reviewService.createPendingReview(
            null,
            resource.id,
            phaseId,
            this.postMortemScorecardId,
            challengeId,
          );

          if (created) {
            createdCount++;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[ZERO SUBMISSIONS] Failed to create post-mortem review for challenge ${challengeId}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      this.logger.log(
        `[ZERO SUBMISSIONS] Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[ZERO SUBMISSIONS] Unable to prepare post-mortem reviewers for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async handlePostMortemPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<void> {
    await this.challengeApiService.cancelChallenge(
      data.challengeId,
      ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
    );

    this.logger.log(
      `[ZERO SUBMISSIONS] Marked challenge ${data.challengeId} as CANCELLED_ZERO_SUBMISSIONS after Post-Mortem completion.`,
    );
  }

  private async deferRegistrationPhaseClosure(
    data: PhaseTransitionPayload,
  ): Promise<void> {
    const key = this.buildRegistrationPhaseKey(data.challengeId, data.phaseId);
    const attempt = (this.registrationCloseRetryAttempts.get(key) ?? 0) + 1;
    this.registrationCloseRetryAttempts.set(key, attempt);

    const delay = this.computeRegistrationCloseRetryDelay(attempt);
    const nextRun = new Date(Date.now() + delay).toISOString();

    const payload: PhaseTransitionPayload = {
      ...data,
      date: nextRun,
      operator: data.operator ?? AutopilotOperator.SYSTEM_SCHEDULER,
    };

    try {
      await this.schedulePhaseTransition(payload);
      this.logger.warn(
        `[REGISTRATION] Deferred closing registration phase ${data.phaseId} for challenge ${data.challengeId}; awaiting first submitter. Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.registrationCloseRetryAttempts.delete(key);
      this.logger.error(
        `[REGISTRATION] Failed to reschedule registration closure for challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private computeRegistrationCloseRetryDelay(attempt: number): number {
    const multiplier = Math.max(attempt, 1);
    const delay = this.registrationCloseRetryBaseDelayMs * multiplier;
    return Math.min(delay, this.registrationCloseRetryMaxDelayMs);
  }

  private buildRegistrationPhaseKey(
    challengeId: string,
    phaseId: string,
  ): string {
    return `${challengeId}|${phaseId}|registration-close`;
  }

  private async deferReviewPhaseClosure(
    data: PhaseTransitionPayload,
    pendingCount?: number,
  ): Promise<void> {
    const key = this.buildReviewPhaseKey(data.challengeId, data.phaseId);
    const attempt = (this.reviewCloseRetryAttempts.get(key) ?? 0) + 1;
    this.reviewCloseRetryAttempts.set(key, attempt);

    const delay = this.computeReviewCloseRetryDelay(attempt);
    const nextRun = new Date(Date.now() + delay).toISOString();

    const payload: PhaseTransitionPayload = {
      ...data,
      date: nextRun,
      operator: data.operator ?? AutopilotOperator.SYSTEM_SCHEDULER,
    };

    try {
      await this.schedulePhaseTransition(payload);
      const pendingDescription =
        typeof pendingCount === 'number' && pendingCount >= 0
          ? pendingCount
          : 'unknown';

      this.logger.warn(
        `[REVIEW LATE] Deferred closing review phase ${data.phaseId} for challenge ${data.challengeId}; ${pendingDescription} incomplete review(s) detected. Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[REVIEW LATE] Failed to reschedule close for review phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      this.reviewCloseRetryAttempts.delete(key);
      throw err;
    }
  }

  private computeReviewCloseRetryDelay(attempt: number): number {
    const multiplier = Math.max(attempt, 1);
    const delay = this.reviewCloseRetryBaseDelayMs * multiplier;
    return Math.min(delay, this.reviewCloseRetryMaxDelayMs);
  }

  private buildReviewPhaseKey(challengeId: string, phaseId: string): string {
    return `${challengeId}|${phaseId}`;
  }

  private async deferAppealsPhaseClosure(
    data: PhaseTransitionPayload,
    pendingCount?: number,
  ): Promise<void> {
    const key = this.buildAppealsPhaseKey(data.challengeId, data.phaseId);
    const attempt = (this.appealsCloseRetryAttempts.get(key) ?? 0) + 1;
    this.appealsCloseRetryAttempts.set(key, attempt);

    const delay = this.computeAppealsCloseRetryDelay(attempt);
    const nextRun = new Date(Date.now() + delay).toISOString();

    const payload: PhaseTransitionPayload = {
      ...data,
      date: nextRun,
      operator: data.operator ?? AutopilotOperator.SYSTEM_SCHEDULER,
    };

    try {
      await this.schedulePhaseTransition(payload);
      const pendingDescription =
        typeof pendingCount === 'number' && pendingCount >= 0
          ? pendingCount
          : 'unknown';

      this.logger.warn(
        `[APPEALS LATE] Deferred closing appeals phase ${data.phaseId} for challenge ${data.challengeId}; ${pendingDescription} pending appeal response(s). Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[APPEALS LATE] Failed to reschedule close for appeals phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      this.appealsCloseRetryAttempts.delete(key);
      throw err;
    }
  }

  private computeAppealsCloseRetryDelay(attempt: number): number {
    const multiplier = Math.max(attempt, 1);
    const delay = this.appealsCloseRetryBaseDelayMs * multiplier;
    return Math.min(delay, this.appealsCloseRetryMaxDelayMs);
  }

  private buildAppealsPhaseKey(challengeId: string, phaseId: string): string {
    return `${challengeId}|${phaseId}|appeals-close`;
  }

  private isAppealsPhaseName(phaseName?: string | null): boolean {
    const normalized = phaseName?.trim();
    if (!normalized) {
      return false;
    }

    return this.appealsPhaseNames.has(normalized);
  }

  private isAppealsResponsePhaseName(
    phaseName?: string | null,
  ): boolean {
    const normalized = phaseName?.trim();
    if (!normalized) {
      return false;
    }

    return this.appealsResponsePhaseNames.has(normalized);
  }
}
