import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  IChallenge,
  IChallengeReviewer,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import {
  REVIEW_PHASE_NAMES,
  getRoleNamesForPhase,
} from '../constants/review.constants';

interface PhaseSummary {
  id: string;
  phaseId: string;
  name: string;
}

interface PollerContext {
  processing: boolean;
  interval: NodeJS.Timeout;
}

interface AssignmentStatus {
  ready: boolean;
  required: number;
  assigned: number;
  phaseMissing: boolean;
  phaseOpen: boolean;
}

@Injectable()
export class ReviewAssignmentService {
  private readonly logger = new Logger(ReviewAssignmentService.name);
  private readonly pollers = new Map<string, PollerContext>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly resourcesService: ResourcesService,
  ) {
    const configuredInterval = this.configService.get<number>(
      'review.assignmentPollIntervalMs',
    );

    const defaultInterval = 5 * 60 * 1000; // 5 minutes
    this.pollIntervalMs = configuredInterval && configuredInterval > 0
      ? configuredInterval
      : defaultInterval;
  }

  async ensureAssignmentsOrSchedule(
    challengeId: string,
    phase: IPhase,
    openPhaseCallback: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!REVIEW_PHASE_NAMES.has(phase.name)) {
      return true;
    }

    const status = await this.evaluateAssignmentStatus(challengeId, phase);
    const phaseKey = this.buildKey(challengeId, phase.id);

    if (status.phaseMissing) {
      this.logger.warn(
        `Review phase ${phase.id} not found when verifying assignments for challenge ${challengeId}. Proceeding with opening to avoid blocking phase chain.`,
      );
      this.clearPolling(challengeId, phase.id);
      return true;
    }

    if (status.phaseOpen || status.ready) {
      this.clearPolling(challengeId, phase.id);
      return true;
    }

    this.logger.warn(
      `Insufficient reviewers for challenge ${challengeId} phase ${phase.id} (${phase.name}). Required: ${status.required}, Assigned: ${status.assigned}. Deferring phase opening and polling every ${Math.round(this.pollIntervalMs / 1000)}s.`,
    );

    if (!this.pollers.has(phaseKey)) {
      this.startPolling(challengeId, phase, openPhaseCallback);
    }

    return false;
  }

  clearPolling(challengeId: string, phaseId: string): void {
    const key = this.buildKey(challengeId, phaseId);
    const context = this.pollers.get(key);

    if (!context) {
      return;
    }

    if (this.schedulerRegistry.doesExist('interval', key)) {
      this.schedulerRegistry.deleteInterval(key);
    }

    clearInterval(context.interval);
    this.pollers.delete(key);
    this.logger.debug(
      `Stopped reviewer assignment polling for challenge ${challengeId}, phase ${phaseId}.`,
    );
  }

  private startPolling(
    challengeId: string,
    phase: PhaseSummary,
    openPhaseCallback: () => Promise<boolean>,
  ): void {
    const key = this.buildKey(challengeId, phase.id);

    if (this.pollers.has(key)) {
      return;
    }

    const context: PollerContext = {
      processing: false,
      interval: setInterval(async () => {
        if (context.processing) {
          return;
        }

        context.processing = true;
        try {
          const status = await this.evaluateAssignmentStatus(challengeId, phase);

          if (status.phaseMissing) {
            this.logger.warn(
              `Review phase ${phase.id} no longer exists on challenge ${challengeId}. Stopping assignment polling.`,
            );
            this.clearPolling(challengeId, phase.id);
            return;
          }

          if (status.phaseOpen) {
            this.logger.log(
              `Review phase ${phase.id} for challenge ${challengeId} is already open. Stopping assignment polling.`,
            );
            this.clearPolling(challengeId, phase.id);
            return;
          }

          if (!status.ready) {
            return;
          }

          this.logger.log(
            `Required reviewers detected for challenge ${challengeId}, phase ${phase.id}. Opening review phase automatically.`,
          );
          await openPhaseCallback();
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Error while polling reviewer assignments for challenge ${challengeId}, phase ${phase.id}: ${err.message}`,
            err.stack,
          );
        } finally {
          context.processing = false;
        }
      }, this.pollIntervalMs),
    };

    this.schedulerRegistry.addInterval(key, context.interval);
    this.pollers.set(key, context);
  }

  private async evaluateAssignmentStatus(
    challengeId: string,
    phase: PhaseSummary,
  ): Promise<AssignmentStatus> {
    let challenge: IChallenge;

    try {
      challenge = await this.challengeApiService.getChallengeById(challengeId);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to fetch challenge ${challengeId} while verifying reviewer assignments: ${err.message}`,
        err.stack,
      );
      return {
        ready: false,
        required: 0,
        assigned: 0,
        phaseMissing: true,
        phaseOpen: false,
      };
    }

    const phaseDetails = challenge.phases.find((p) => p.id === phase.id);

    if (!phaseDetails) {
      return {
        ready: false,
        required: 0,
        assigned: 0,
        phaseMissing: true,
        phaseOpen: false,
      };
    }

    if (phaseDetails.isOpen) {
      return {
        ready: true,
        required: 0,
        assigned: 0,
        phaseMissing: false,
        phaseOpen: true,
      };
    }

    const reviewerConfigs = this.getReviewerConfigsForPhase(
      challenge.reviewers,
      phaseDetails.phaseId,
    );

    if (reviewerConfigs.length === 0) {
      return {
        ready: true,
        required: 0,
        assigned: 0,
        phaseMissing: false,
        phaseOpen: false,
      };
    }

    const required = reviewerConfigs.reduce((total, config) => {
      const count = config.memberReviewerCount ?? 1;
      return total + Math.max(count, 0);
    }, 0);

    if (required === 0) {
      return {
        ready: true,
        required: 0,
        assigned: 0,
        phaseMissing: false,
        phaseOpen: false,
      };
    }

    const roleNames = getRoleNamesForPhase(phaseDetails.name);
    const assignedReviewers = await this.resourcesService.getReviewerResources(
      challengeId,
      roleNames,
    );

    const assigned = assignedReviewers.length;
    const ready = assigned >= required;

    return {
      ready,
      required,
      assigned,
      phaseMissing: false,
      phaseOpen: false,
    };
  }

  private getReviewerConfigsForPhase(
    reviewers: IChallengeReviewer[],
    phaseTemplateId: string,
  ): IChallengeReviewer[] {
    return reviewers.filter(
      (reviewer) =>
        reviewer.isMemberReview && reviewer.phaseId === phaseTemplateId,
    );
  }

  private buildKey(challengeId: string, phaseId: string): string {
    return `${challengeId}:${phaseId}:reviewer-assignment`;
  }
}
