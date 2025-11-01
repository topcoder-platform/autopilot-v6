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
import { FinanceApiService } from '../../finance/finance-api.service';
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
  POST_MORTEM_REVIEWER_ROLE_NAME,
  REGISTRATION_PHASE_NAME,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
  SUBMISSION_PHASE_NAME,
  TOPGEAR_SUBMISSION_PHASE_NAME,
  getRoleNamesForPhase,
  isPostMortemPhaseName,
} from '../constants/review.constants';
import { ResourcesService } from '../../resources/resources.service';
import { isTopgearTaskChallenge } from '../constants/challenge.constants';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { PhaseChangeNotificationService } from './phase-change-notification.service';
import {
  getNormalizedStringArray,
  isActiveStatus,
} from '../utils/config.utils';
import {
  getMemberReviewerConfigs,
  getReviewerConfigsForPhase,
} from '../utils/reviewer.utils';

const PHASE_QUEUE_NAME = 'autopilot-phase-transitions';
const PHASE_QUEUE_PREFIX = '{autopilot-phase-transitions}';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private topgearPostMortemLocks = new Set<string>();
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
  private readonly appealsOpenRetryAttempts = new Map<string, number>();
  private readonly appealsOpenRetryBaseDelayMs = 10 * 60 * 1000;
  private readonly appealsOpenRetryMaxDelayMs = 60 * 60 * 1000;
  private readonly screeningCloseRetryAttempts = new Map<string, number>();
  private readonly screeningCloseRetryBaseDelayMs = 10 * 60 * 1000;
  private readonly screeningCloseRetryMaxDelayMs = 60 * 60 * 1000;
  private readonly approvalCloseRetryAttempts = new Map<string, number>();
  private readonly approvalCloseRetryBaseDelayMs = 10 * 60 * 1000;
  private readonly approvalCloseRetryMaxDelayMs = 60 * 60 * 1000;
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
    private readonly financeApiService: FinanceApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly phaseChangeNotificationService: PhaseChangeNotificationService,
    private readonly configService: ConfigService,
  ) {
    this.submitterRoles = getNormalizedStringArray(
      this.configService.get('autopilot.submitterRoles'),
      ['Submitter'],
    );
    const configuredPostMortemRoles = getNormalizedStringArray(
      this.configService.get('autopilot.postMortemRoles'),
      [POST_MORTEM_REVIEWER_ROLE_NAME],
    );
    const uniquePostMortemRoles = new Set<string>([
      POST_MORTEM_REVIEWER_ROLE_NAME,
      ...configuredPostMortemRoles,
    ]);
    this.postMortemRoles = Array.from(uniquePostMortemRoles);
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
      getNormalizedStringArray(
        this.configService.get('autopilot.appealsPhaseNames'),
        ['Appeals'],
      ),
    );
    this.appealsResponsePhaseNames = new Set(
      getNormalizedStringArray(
        this.configService.get('autopilot.appealsResponsePhaseNames'),
        ['Appeals Response'],
      ),
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

      // Normalize the payload to reflect a scheduler-initiated transition
      const effectiveData: PhaseTransitionPayload = {
        ...phaseData,
        state: phaseData.state || 'END',
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        date: new Date().toISOString(),
      };

      await this.triggerKafkaEvent(effectiveData);

      // Call advancePhase method when phase transition is triggered
      // Use the normalized operator so scheduler-specific rules apply
      await this.advancePhase(effectiveData);
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
      const isScreeningPhase =
        SCREENING_PHASE_NAMES.has(phaseName) ||
        SCREENING_PHASE_NAMES.has(data.phaseTypeName);
      const isApprovalPhase =
        APPROVAL_PHASE_NAMES.has(phaseName) ||
        APPROVAL_PHASE_NAMES.has(data.phaseTypeName);

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

      // Registration close handling
      if (operation === 'close' && phaseName === REGISTRATION_PHASE_NAME) {
        try {
          // Only defer scheduler-initiated closes for Topgear tasks
          if (isSchedulerInitiated) {
            const regChallenge = await this.challengeApiService.getChallengeById(
              data.challengeId,
            );
            if (isTopgearTaskChallenge(regChallenge.type)) {
              await this.deferTopgearRegistrationPhaseClosure(data);
              return;
            }
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[REGISTRATION] Failed Topgear registration check for challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );
          // Fall through to legacy behavior below on error
        }
        // Do NOT defer closing Registration when there are no submitters.
        // We will close Registration now and trigger the zero-registrations Post-Mortem workflow after close.
        try {
          const hasSubmitter = await this.resourcesService.hasSubmitterResource(
            data.challengeId,
            this.submitterRoles,
          );

          if (!hasSubmitter) {
            this.logger.log(
              `[ZERO REGISTRATIONS] No registered submitters detected for challenge ${data.challengeId} at Registration close; will create Post-Mortem and cancel after completion.`,
            );
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[REGISTRATION] Failed to verify submitter resources for challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );
          // Proceed with close; post-close handler will attempt the zero-registrations flow.
        }
      }

      if (operation === 'close' && isReviewPhase) {
        try {
          const coverage = await this.verifyReviewerCoverage(
            data.challengeId,
            data.phaseId,
            phaseName,
            true,
          );

          if (!coverage.satisfied) {
            await this.deferReviewPhaseClosure(
              data,
              undefined,
              `insufficient reviewer coverage (${coverage.actual}/${coverage.expected} assigned)`,
            );
            return;
          }

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
            `[REVIEW LATE] Unable to verify review readiness for phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );

          await this.deferReviewPhaseClosure(
            data,
            undefined,
            'unable to verify review readiness',
          );
          return;
        }
      }

      // Block closing Screening until all screening scorecards are submitted
      if (operation === 'close' && isScreeningPhase) {
        try {
          const coverage = await this.verifyReviewerCoverage(
            data.challengeId,
            data.phaseId,
            phaseName,
            false,
          );

          if (!coverage.satisfied) {
            await this.deferScreeningPhaseClosure(
              data,
              undefined,
              `insufficient screening coverage (${coverage.actual}/${coverage.expected} assigned)`,
            );
            return;
          }

          const pendingScreening = await this.reviewService.getPendingReviewCount(
            data.phaseId,
            data.challengeId,
          );

          if (pendingScreening > 0) {
            await this.deferScreeningPhaseClosure(data, pendingScreening);
            return;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[SCREENING LATE] Unable to verify screening readiness for phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );

          await this.deferScreeningPhaseClosure(
            data,
            undefined,
            'unable to verify screening readiness',
          );
          return;
        }
      }

      // Block closing Approval until all approval scorecards are submitted
      if (operation === 'close' && isApprovalPhase) {
        try {
          const coverage = await this.verifyReviewerCoverage(
            data.challengeId,
            data.phaseId,
            phaseName,
            true,
          );

          if (!coverage.satisfied) {
            await this.deferApprovalPhaseClosure(
              data,
              undefined,
              `insufficient approval coverage (${coverage.actual}/${coverage.expected} assigned)`,
            );
            return;
          }

          const pendingApproval = await this.reviewService.getPendingReviewCount(
            data.phaseId,
            data.challengeId,
          );

          if (pendingApproval > 0) {
            await this.deferApprovalPhaseClosure(data, pendingApproval);
            return;
          }

          // If there are zero pending reviews, ensure at least one approval review exists
          const completedCount =
            await this.reviewService.getCompletedReviewCountForPhase(
              data.phaseId,
            );
          if (completedCount === 0) {
            await this.deferApprovalPhaseClosure(
              data,
              0,
              'no completed approval reviews detected',
            );
            return;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[APPROVAL LATE] Unable to verify approval readiness for phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
            err.stack,
          );

          await this.deferApprovalPhaseClosure(
            data,
            undefined,
            'unable to verify approval readiness',
          );
          return;
        }
      }

      if (operation === 'close' && isTopgearSubmissionPhase && isSchedulerInitiated) {
        const handled = await this.handleTopgearSubmissionLate(data, phaseDetails);
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

      // Safety check: do not open Appeals if predecessor review has pending reviews
      if (operation === 'open' && isAppealsPhase) {
        try {
          const challenge =
            await this.challengeApiService.getChallengeById(data.challengeId);

          const phaseToOpen = challenge.phases?.find(
            (p) => p.id === data.phaseId,
          );

          // Identify predecessor phase; if not present, try to find the last review phase
          let predecessor: IPhase | undefined;
          if (phaseToOpen?.predecessor) {
            predecessor = challenge.phases?.find(
              (p) =>
                p.phaseId === phaseToOpen.predecessor ||
                p.id === phaseToOpen.predecessor,
            );
          }

          // Fallback: choose the most recent review phase by scheduledEndDate
          if (!predecessor) {
            const reviewPhases = (challenge.phases || []).filter((p) =>
              REVIEW_PHASE_NAMES.has(p.name),
            );
            predecessor = reviewPhases
              .filter((p) => Boolean(p.actualEndDate) || Boolean(p.isOpen))
              .sort(
                (a, b) =>
                  new Date(a.scheduledEndDate).getTime() -
                  new Date(b.scheduledEndDate).getTime(),
              )
              .pop();
          }

          if (predecessor && REVIEW_PHASE_NAMES.has(predecessor.name)) {
            const pendingReviews = await this.reviewService.getPendingReviewCount(
              predecessor.id,
              data.challengeId,
            );

            if (pendingReviews > 0) {
              await this.deferAppealsPhaseOpen(data, pendingReviews);
              return;
            }
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[APPEALS OPEN] Unable to verify predecessor reviews before opening appeals for challenge ${data.challengeId}, phase ${data.phaseId}: ${err.message}`,
            err.stack,
          );
          await this.deferAppealsPhaseOpen(data);
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

        try {
          await this.phaseChangeNotificationService.sendPhaseChangeNotification({
            challengeId: data.challengeId,
            phaseId: data.phaseId,
            operation,
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to send phase change notification for challenge ${data.challengeId}, phase ${data.phaseId}: ${err.message}`,
            err.stack,
          );
        }

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

        if (operation === 'close' && isScreeningPhase) {
          this.screeningCloseRetryAttempts.delete(
            this.buildScreeningPhaseKey(data.challengeId, data.phaseId),
          );
        }
        if (operation === 'close' && isApprovalPhase) {
          this.approvalCloseRetryAttempts.delete(
            this.buildApprovalPhaseKey(data.challengeId, data.phaseId),
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

        if (operation === 'open' && isAppealsResponsePhase && isSchedulerInitiated) {
          try {
            const totalAppeals =
              await this.reviewService.getTotalAppealCount(data.challengeId);

            if (totalAppeals === 0) {
              this.logger.log(
                `[APPEALS RESPONSE] No appeals detected for challenge ${data.challengeId}; closing phase ${data.phaseId} immediately after open.`,
              );

              const closePayload: PhaseTransitionPayload = {
                ...data,
                state: 'END',
                operator: AutopilotOperator.SYSTEM_SCHEDULER,
                date: new Date().toISOString(),
              };

              await this.advancePhase(closePayload);
              return;
            }
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `[APPEALS RESPONSE] Unable to auto-close phase ${data.phaseId} for challenge ${data.challengeId}: ${err.message}`,
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
          } else if (isScreeningPhase) {
            try {
              const handled = await this.handleScreeningPhaseClosed(data);
              if (handled) {
                skipPhaseChain = true;
                skipFinalization = true;
              }
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[SCREENING FAILED] Unable to process screening failure workflow for challenge ${data.challengeId}: ${err.message}`,
                err.stack,
              );
            }
          } else if (phaseName === 'Checkpoint Review') {
            try {
              await this.challengeCompletionService.assignCheckpointWinners(
                data.challengeId,
                data.phaseId,
              );
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[CHECKPOINT WINNERS] Unable to assign checkpoint winners for challenge ${data.challengeId}: ${err.message}`,
                err.stack,
              );
            }
          } else if (phaseName === REGISTRATION_PHASE_NAME) {
            try {
              const handled = await this.handleRegistrationPhaseClosed(data);
              if (handled) {
                skipPhaseChain = true;
                skipFinalization = true;
              }
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[ZERO REGISTRATIONS] Unable to process post-registration workflow for challenge ${data.challengeId}: ${err.message}`,
                err.stack,
              );
            }
          } else if (isPostMortemPhaseName(phaseName)) {
            try {
              await this.handlePostMortemPhaseClosed(data);
              skipFinalization = true;
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `Failed to cancel challenge ${data.challengeId} after post-mortem closure: ${err.message}`,
                err.stack,
              );
            }
          }

          // For Topgear tasks, finalize immediately after Topgear Submission closes,
          // even if Post-Mortem was opened and remains active.
          if (phaseName === TOPGEAR_SUBMISSION_PHASE_NAME) {
            try {
              await this.attemptChallengeFinalization(data.challengeId);
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `[TOPGEAR] Failed to attempt finalization for challenge ${data.challengeId} after closing Topgear Submission phase ${data.phaseId}: ${err.message}`,
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
              !data.preventFinalization &&
              !hasOpenPhases &&
              !hasNextPhases &&
              !hasIncompletePhases
            ) {
              await this.attemptChallengeFinalization(data.challengeId);
            } else {
              if (!skipFinalization && data.preventFinalization) {
                this.logger.debug?.(
                  `Challenge ${data.challengeId} finalization deferred after closing phase ${data.phaseId}; preventFinalization flag set.`,
                );
              }
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

  public async evaluateManualPhaseCompletion(
    challenge: IChallenge,
  ): Promise<void> {
    if (!challenge) {
      return;
    }

    if (!isActiveStatus(challenge.status)) {
      return;
    }

    const phases = challenge.phases ?? [];
    if (phases.length === 0) {
      return;
    }

    const openPhase = phases.find((phase) => phase.isOpen);
    if (openPhase) {
      this.logger.debug?.(
        `[MANUAL COMPLETION] Skipping challenge ${challenge.id}; phase ${openPhase.name} (${openPhase.id}) is still open.`,
      );
      return;
    }

    const incompletePhase = phases.find(
      (phase) => !phase.actualEndDate && !phase.isOpen,
    );
    if (incompletePhase) {
      this.logger.debug?.(
        `[MANUAL COMPLETION] Skipping challenge ${challenge.id}; phase ${incompletePhase.name} (${incompletePhase.id}) has no actual end date.`,
      );
      return;
    }

    const completedPhases = phases
      .filter((phase) => Boolean(phase.actualEndDate))
      .sort((a, b) => {
        const aTime = a.actualEndDate
          ? new Date(a.actualEndDate).getTime()
          : 0;
        const bTime = b.actualEndDate
          ? new Date(b.actualEndDate).getTime()
          : 0;
        return aTime - bTime;
      });

    const lastClosedPhase = completedPhases.at(-1);
    if (!lastClosedPhase) {
      return;
    }

    if (
      this.finalizationAttempts.has(challenge.id) ||
      this.finalizationRetryTimers.has(challenge.id)
    ) {
      this.logger.debug?.(
        `[MANUAL COMPLETION] Challenge ${challenge.id} is already queued for finalization; skipping duplicate trigger.`,
      );
      return;
    }

    const phaseLabel = `${lastClosedPhase.name} (${lastClosedPhase.id})`;
    this.logger.log(
      `[MANUAL COMPLETION] Detected that all phases are closed for challenge ${challenge.id}. Last phase closed: ${phaseLabel}. Triggering finalization.`,
    );
    await this.attemptChallengeFinalization(challenge.id);
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
    return this.computeBackoffDelay(
      attempt,
      this.finalizationRetryBaseDelayMs,
      this.finalizationRetryMaxDelayMs,
    );
  }

  private clearFinalizationRetry(challengeId: string): void {
    const timer = this.finalizationRetryTimers.get(challengeId);
    if (timer) {
      clearTimeout(timer);
    }
    this.finalizationRetryTimers.delete(challengeId);
  }

  // Centralized linear backoff helper used by various deferral strategies
  private computeBackoffDelay(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
  ): number {
    const multiplier = Math.max(attempt, 1);
    const delay = baseDelayMs * multiplier;
    return Math.min(delay, maxDelayMs);
  }

  private isSchedulerInitiatedOperator(
    operator?: AutopilotOperator | string,
  ): boolean {
    if (!operator) {
      return false;
    }

    const candidate = operator.toString().toLowerCase();
    // Treat all system-scheduled operators as scheduler-initiated.
    // Includes: system-scheduler, system-phase-chain, system-new-challenge,
    // system-sync, system-recovery (and other future system-* operators).
    // Intentionally excludes bare 'system' to allow explicit closes (e.g., after passing review).
    return candidate.startsWith('system-');
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
        `[TOPGEAR] Keeping submission phase ${phase.id} open for challenge ${data.challengeId}; awaiting passing iterative review. No post-mortem will be created.`,
      );

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

  private async deferTopgearRegistrationPhaseClosure(
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
        `[TOPGEAR][REGISTRATION] Deferred closing registration phase ${data.phaseId} for challenge ${data.challengeId}; awaiting passing iterative review. Retrying in ${Math.round(
          delay / 60000,
        )} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.registrationCloseRetryAttempts.delete(key);
      this.logger.error(
        `[TOPGEAR][REGISTRATION] Failed to reschedule registration closure for challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async ensureTopgearPostMortemReview(
    challenge: IChallenge,
    submissionPhase: IPhase,
    data: PhaseTransitionPayload,
  ): Promise<void> {
    // Prevent concurrent duplicate creations for the same challenge within this process
    this.topgearPostMortemLocks = this.topgearPostMortemLocks || new Set<string>();
    if (this.topgearPostMortemLocks.has(challenge.id)) {
      this.logger.debug?.(
        `[TOPGEAR] Post-Mortem creation already in progress for challenge ${challenge.id}; skipping.`,
      );
      return;
    }
    this.topgearPostMortemLocks.add(challenge.id);
    try {
    // Determine scorecard to use: env var or fallback by name
    let scorecardId = this.topgearPostMortemScorecardId;
    if (!scorecardId) {
      try {
        scorecardId = await this.reviewService.getScorecardIdByName(
          'Topgear Task Post Mortem',
        );
      } catch (err) {
        // Already logged in review service
      }
    }

    if (!scorecardId) {
      this.logger.warn(
        `[TOPGEAR] Post-mortem scorecard is not configured or found by name; skipping creation for challenge ${challenge.id}.`,
      );
      return;
    }

    let postMortemPhase =
      challenge.phases?.find((p) => isPostMortemPhaseName(p.name)) ?? null;

    if (!postMortemPhase) {
      try {
        // Create a Post-Mortem phase chained after the submission phase, but keep it closed.
        // We preserve future phases (e.g., Iterative Review) and let phase chain open Post-Mortem
        // only after the submission phase is closed (which will happen after a successful IR).
        postMortemPhase =
          await this.challengeApiService.createPostMortemPhasePreserving(
            challenge.id,
            submissionPhase.id,
            this.postMortemDurationHours,
            false,
          );
        this.logger.log(
          `[TOPGEAR] Created Post-Mortem phase ${postMortemPhase.id} for challenge ${challenge.id} due to late submission.`,
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[TOPGEAR] Failed to create Post-Mortem phase for challenge ${challenge.id}: ${err.message}`,
          err.stack,
        );
        return;
      }
    }

    // Do NOT pre-create pending reviews or schedule closure here.
    // The phase chain will open Post-Mortem only after submission closes (after successful IR),
    // and standard open-phase handling will create pending reviews and schedule closure.
    } finally {
      this.topgearPostMortemLocks.delete(challenge.id);
    }
  }

  private async handleSubmissionPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<boolean> {
    try {
      // Only consider active contest submissions (include null type as contest)
      const contestSubmissionIds =
        await this.reviewService.getActiveContestSubmissionIds(
          data.challengeId,
        );

      if (contestSubmissionIds.length > 0) {
        return false;
      }

      this.logger.log(
        `[ZERO SUBMISSIONS] No active submissions found for challenge ${data.challengeId}; transitioning to Post-Mortem phase.`,
      );

      const hasSubmitter = await this.resourcesService.hasSubmitterResource(
        data.challengeId,
        this.submitterRoles,
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

      const cancelStatus = hasSubmitter
        ? ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS
        : ChallengeStatusEnum.CANCELLED_ZERO_REGISTRATIONS;

      await this.challengeApiService.cancelChallenge(
        data.challengeId,
        cancelStatus,
      );

      this.logger.log(
        `${hasSubmitter ? '[ZERO SUBMISSIONS]' : '[ZERO REGISTRATIONS]'} Marked challenge ${data.challengeId} as ${cancelStatus} while keeping Post-Mortem phase ${postMortemPhase.id} open.`,
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

  private async handleRegistrationPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<boolean> {
    try {
      const hasSubmitter = await this.resourcesService.hasSubmitterResource(
        data.challengeId,
        this.submitterRoles,
      );

      if (hasSubmitter) {
        // Nothing to do; proceed with normal chain.
        return false;
      }

      this.logger.log(
        `[ZERO REGISTRATIONS] No registered submitters found for challenge ${data.challengeId}; transitioning to Post-Mortem phase.`,
      );

      const postMortemPhase = await this.challengeApiService.createPostMortemPhase(
        data.challengeId,
        data.phaseId,
        this.postMortemDurationHours,
      );

      await this.createPostMortemPendingReviewsForCopilot(
        data.challengeId,
        postMortemPhase.id,
      );

      if (!postMortemPhase.scheduledEndDate) {
        this.logger.warn(
          `[ZERO REGISTRATIONS] Created Post-Mortem phase ${postMortemPhase.id} for challenge ${data.challengeId} without a scheduled end date. Manual intervention required to close the phase.`,
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
        `[ZERO REGISTRATIONS] Scheduled Post-Mortem phase ${postMortemPhase.id} closure for challenge ${data.challengeId} at ${postMortemPhase.scheduledEndDate}.`,
      );

      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[ZERO REGISTRATIONS] Failed to prepare Post-Mortem workflow for challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async handleScreeningPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<boolean> {
    let cancellationSucceeded = false;

    try {
      const challenge = await this.challengeApiService.getChallengeById(
        data.challengeId,
      );

      const screeningScorecardIds = this.getScreeningScorecardIds(challenge);

      const activeSubmissionIds =
        await this.reviewService.getActiveContestSubmissionIds(
          data.challengeId,
        );

      if (activeSubmissionIds.length === 0) {
        return false;
      }

      const activeSubmissionIdSet = new Set(activeSubmissionIds);

      const failedSubmissionIds =
        await this.reviewService.getFailedScreeningSubmissionIds(
          data.challengeId,
          screeningScorecardIds,
        );

      const passedSubmissionIds =
        await this.reviewService.getPassedScreeningSubmissionIds(
          data.challengeId,
          screeningScorecardIds,
        );

      const hasPassingActiveSubmissions = Array.from(passedSubmissionIds).some(
        (submissionId) => activeSubmissionIdSet.has(submissionId),
      );

      if (hasPassingActiveSubmissions) {
        this.logger.log(
          `[SCREENING FAILED] Detected active submissions with passing screening review for challenge ${data.challengeId}; skipping cancellation workflow.`,
        );
        return false;
      }

      for (const passedSubmissionId of passedSubmissionIds) {
        failedSubmissionIds.delete(passedSubmissionId);
      }

      if (failedSubmissionIds.size !== activeSubmissionIdSet.size) {
        return false;
      }

      this.logger.log(
        `[SCREENING FAILED] All active submissions failed screening for challenge ${data.challengeId}; initiating cancellation workflow.`,
      );

      await this.challengeApiService.cancelChallenge(
        data.challengeId,
        ChallengeStatusEnum.CANCELLED_FAILED_SCREENING,
      );

      cancellationSucceeded = true;

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
          `[SCREENING FAILED] Created Post-Mortem phase ${postMortemPhase.id} for challenge ${data.challengeId} without a scheduled end date. Manual intervention required to close the phase.`,
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
        `[SCREENING FAILED] Scheduled Post-Mortem phase ${postMortemPhase.id} closure for challenge ${data.challengeId} at ${postMortemPhase.scheduledEndDate}.`,
      );
      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[SCREENING FAILED] Failed to process screening failure workflow for challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    } finally {
      if (cancellationSucceeded) {
        void this.financeApiService.generateChallengePayments(data.challengeId);
      }
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
      const reviewerAndCopilotResources =
        await this.resourcesService.getResourcesByRoleNames(
          challengeId,
          ['Reviewer', 'Copilot'],
        );
      const resources =
        await this.resourcesService.ensureResourcesForMembers(
          challengeId,
          reviewerAndCopilotResources,
          POST_MORTEM_REVIEWER_ROLE_NAME,
        );

      if (!resources.length) {
        this.logger.log(
          `[ZERO SUBMISSIONS] No resources found for ${POST_MORTEM_REVIEWER_ROLE_NAME} role on challenge ${challengeId}; skipping review creation.`,
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

  private async createPostMortemPendingReviewsForCopilot(
    challengeId: string,
    phaseId: string,
  ): Promise<void> {
    if (!this.postMortemScorecardId) {
      this.logger.warn(
        `[ZERO REGISTRATIONS] Post-mortem scorecard ID is not configured; skipping review creation for challenge ${challengeId}.`,
      );
      return;
    }

    try {
      const copilots = await this.resourcesService.getResourcesByRoleNames(
        challengeId,
        ['Copilot'],
      );

      if (!copilots.length) {
        this.logger.log(
          `[ZERO REGISTRATIONS] No Copilot resource found on challenge ${challengeId}; skipping review creation.`,
        );
        return;
      }

      const resources =
        await this.resourcesService.ensureResourcesForMembers(
          challengeId,
          copilots,
          POST_MORTEM_REVIEWER_ROLE_NAME,
        );

      if (!resources.length) {
        this.logger.log(
          `[ZERO REGISTRATIONS] No resources found for ${POST_MORTEM_REVIEWER_ROLE_NAME} role on challenge ${challengeId}; skipping review creation.`,
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
            `[ZERO REGISTRATIONS] Failed to create post-mortem review for challenge ${challengeId}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      this.logger.log(
        `[ZERO REGISTRATIONS] Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId} (${POST_MORTEM_REVIEWER_ROLE_NAME}).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[ZERO REGISTRATIONS] Unable to prepare Copilot post-mortem reviewers for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async handlePostMortemPhaseClosed(
    data: PhaseTransitionPayload,
  ): Promise<void> {
    try {
      const hasSubmitter = await this.resourcesService.hasSubmitterResource(
        data.challengeId,
        this.submitterRoles,
      );
      const statusTag = hasSubmitter
        ? '[ZERO SUBMISSIONS]'
        : '[ZERO REGISTRATIONS]';

      const status = hasSubmitter
        ? ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS
        : ChallengeStatusEnum.CANCELLED_ZERO_REGISTRATIONS;

      const challenge =
        await this.challengeApiService.getChallengeById(data.challengeId);
      const currentStatus = (challenge.status ?? '').toUpperCase();

      if (currentStatus === status) {
        this.logger.log(
          `${statusTag} Challenge ${data.challengeId} already ${status}; no additional cancellation required after Post-Mortem completion.`,
        );
        return;
      }

      if (
        currentStatus.startsWith('CANCELLED') &&
        currentStatus !== status
      ) {
        this.logger.warn(
          `${statusTag} Challenge ${data.challengeId} already cancelled as ${currentStatus}; skipping status override to ${status} after Post-Mortem completion.`,
        );
        return;
      }

      await this.challengeApiService.cancelChallenge(data.challengeId, status);

      this.logger.log(
        `${statusTag} Marked challenge ${data.challengeId} as ${status} after Post-Mortem completion.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to cancel challenge ${data.challengeId} after Post-Mortem completion: ${err.message}`,
        err.stack,
      );
      throw err;
    }
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
    return this.computeBackoffDelay(
      attempt,
      this.registrationCloseRetryBaseDelayMs,
      this.registrationCloseRetryMaxDelayMs,
    );
  }

  private buildRegistrationPhaseKey(
    challengeId: string,
    phaseId: string,
  ): string {
    return `${challengeId}|${phaseId}|registration-close`;
  }

  private async verifyReviewerCoverage(
    challengeId: string,
    phaseId: string,
    phaseName: string,
    useMemberConfigs: boolean,
  ): Promise<{ satisfied: boolean; expected: number; actual: number }> {
    try {
      const challenge = await this.challengeApiService.getChallengeById(
        challengeId,
      );

      const phase = challenge?.phases?.find((p) => p.id === phaseId);

      if (!phase?.phaseId) {
        this.logger.warn(
          `[REVIEW COVERAGE] Unable to locate phase ${phaseId} in challenge ${challengeId} when validating reviewer coverage.`,
        );
        return { satisfied: true, expected: 0, actual: 0 };
      }

      const reviewerConfigs = useMemberConfigs
        ? getMemberReviewerConfigs(challenge.reviewers, phase.phaseId)
        : getReviewerConfigsForPhase(challenge.reviewers, phase.phaseId);

      const expected = reviewerConfigs.reduce<number>((total, config) => {
        const count = Math.max(config.memberReviewerCount ?? 1, 0);
        return total + count;
      }, 0);

      if (expected <= 0) {
        return { satisfied: true, expected, actual: 0 };
      }

      const roleNames =
        isPostMortemPhaseName(phaseName) && this.postMortemRoles.length
          ? this.postMortemRoles
          : getRoleNamesForPhase(phaseName);

      const effectiveRoles = roleNames.length ? roleNames : ['Reviewer'];

      const reviewers =
        await this.resourcesService.getReviewerResources(
          challengeId,
          effectiveRoles,
        );

      return {
        satisfied: reviewers.length >= expected,
        expected,
        actual: reviewers.length,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[REVIEW COVERAGE] Failed to verify reviewer coverage for challenge ${challengeId}, phase ${phaseId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async deferReviewPhaseClosure(
    data: PhaseTransitionPayload,
    pendingCount?: number,
    reason?: string,
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

      const reasonMessage =
        reason ?? `${pendingDescription} incomplete review(s) detected`;

      this.logger.warn(
        `[REVIEW LATE] Deferred closing review phase ${data.phaseId} for challenge ${data.challengeId}; ${reasonMessage}. Retrying in ${Math.round(delay / 60000)} minute(s).`,
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

  private async deferScreeningPhaseClosure(
    data: PhaseTransitionPayload,
    pendingCount?: number,
    reason?: string,
  ): Promise<void> {
    const key = this.buildScreeningPhaseKey(data.challengeId, data.phaseId);
    const attempt = (this.screeningCloseRetryAttempts.get(key) ?? 0) + 1;
    this.screeningCloseRetryAttempts.set(key, attempt);

    const delay = this.computeScreeningCloseRetryDelay(attempt);
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

      const reasonMessage =
        reason ?? `${pendingDescription} incomplete screening review(s) detected`;

      this.logger.warn(
        `[SCREENING LATE] Deferred closing screening phase ${data.phaseId} for challenge ${data.challengeId}; ${reasonMessage}. Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[SCREENING LATE] Failed to reschedule close for screening phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      this.screeningCloseRetryAttempts.delete(key);
      throw err;
    }
  }

  private computeScreeningCloseRetryDelay(attempt: number): number {
    return this.computeBackoffDelay(
      attempt,
      this.screeningCloseRetryBaseDelayMs,
      this.screeningCloseRetryMaxDelayMs,
    );
  }

  private buildScreeningPhaseKey(
    challengeId: string,
    phaseId: string,
  ): string {
    return `${challengeId}|${phaseId}|screening-close`;
  }

  private async deferApprovalPhaseClosure(
    data: PhaseTransitionPayload,
    pendingCount?: number,
    reason?: string,
  ): Promise<void> {
    const key = this.buildApprovalPhaseKey(data.challengeId, data.phaseId);
    const attempt = (this.approvalCloseRetryAttempts.get(key) ?? 0) + 1;
    this.approvalCloseRetryAttempts.set(key, attempt);

    const delay = this.computeApprovalCloseRetryDelay(attempt);
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

      const reasonMessage =
        reason ?? `${pendingDescription} incomplete approval review(s) detected`;

      this.logger.warn(
        `[APPROVAL LATE] Deferred closing approval phase ${data.phaseId} for challenge ${data.challengeId}; ${reasonMessage}. Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[APPROVAL LATE] Failed to reschedule close for approval phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      this.approvalCloseRetryAttempts.delete(key);
      throw err;
    }
  }

  private computeApprovalCloseRetryDelay(attempt: number): number {
    return this.computeBackoffDelay(
      attempt,
      this.approvalCloseRetryBaseDelayMs,
      this.approvalCloseRetryMaxDelayMs,
    );
  }

  private buildApprovalPhaseKey(
    challengeId: string,
    phaseId: string,
  ): string {
    return `${challengeId}|${phaseId}|approval-close`;
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
    return this.computeBackoffDelay(
      attempt,
      this.appealsCloseRetryBaseDelayMs,
      this.appealsCloseRetryMaxDelayMs,
    );
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

  private async deferAppealsPhaseOpen(
    data: PhaseTransitionPayload,
    pendingCount?: number,
  ): Promise<void> {
    const key = `${data.challengeId}|${data.phaseId}|appeals-open`;
    const attempt = (this.appealsOpenRetryAttempts.get(key) ?? 0) + 1;
    this.appealsOpenRetryAttempts.set(key, attempt);

    const delay = this.computeAppealsOpenRetryDelay(attempt);
    const nextRun = new Date(Date.now() + delay).toISOString();

    const payload: PhaseTransitionPayload = {
      ...data,
      state: 'START',
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
        `[APPEALS OPEN] Deferred opening appeals phase ${data.phaseId} for challenge ${data.challengeId}; ${pendingDescription} pending review(s) in predecessor. Retrying in ${Math.round(delay / 60000)} minute(s).`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[APPEALS OPEN] Failed to reschedule open for appeals phase ${data.phaseId} on challenge ${data.challengeId}: ${err.message}`,
        err.stack,
      );
      this.appealsOpenRetryAttempts.delete(key);
      throw err;
    }
  }

  private computeAppealsOpenRetryDelay(attempt: number): number {
    return this.computeBackoffDelay(
      attempt,
      this.appealsOpenRetryBaseDelayMs,
      this.appealsOpenRetryMaxDelayMs,
    );
  }

  private getScreeningScorecardIds(challenge: IChallenge): string[] {
    const screeningPhaseTemplateIds = (challenge.phases ?? [])
      .filter((phase) => SCREENING_PHASE_NAMES.has(phase.name))
      .map((phase) => phase.phaseId)
      .filter((phaseId): phaseId is string => Boolean(phaseId));

    const scorecardIds = new Set<string>();

    for (const templateId of screeningPhaseTemplateIds) {
      const configs = getReviewerConfigsForPhase(challenge.reviewers, templateId);

      for (const config of configs) {
        const scorecardId = config.scorecardId?.trim();

        if (scorecardId) {
          scorecardIds.add(scorecardId);
        }
      }
    }

    if (scorecardIds.size === 0) {
      const { legacy } = challenge;

      if (legacy && typeof legacy === 'object') {
        const { screeningScorecardId } = legacy as { screeningScorecardId?: unknown };

        if (typeof screeningScorecardId === 'string') {
          const trimmedScorecardId = screeningScorecardId.trim();

          if (trimmedScorecardId) {
            scorecardIds.add(trimmedScorecardId);
          }
        }
      }
    }

    return Array.from(scorecardIds);
  }
}
