import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { ResourceEventPayload } from '../interfaces/autopilot.interface';
import {
  ITERATIVE_REVIEW_PHASE_NAME,
  PHASE_ROLE_MAP,
  REVIEW_PHASE_NAMES,
} from '../constants/review.constants';
import { First2FinishService } from './first2finish.service';

@Injectable()
export class ResourceEventHandler {
  private readonly logger = new Logger(ResourceEventHandler.name);
  private readonly reviewRoleNames: Set<string>;
  private readonly iterativeRoles: string[];

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly reviewAssignmentService: ReviewAssignmentService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
    private readonly first2FinishService: First2FinishService,
  ) {
    const postMortemRoles = this.getStringArray('autopilot.postMortemRoles', [
      'Reviewer',
      'Copilot',
    ]);
    this.reviewRoleNames = this.computeReviewRoleNames(postMortemRoles);
    this.iterativeRoles = PHASE_ROLE_MAP[ITERATIVE_REVIEW_PHASE_NAME] ?? [
      'Iterative Reviewer',
    ];
  }

  async handleResourceCreated(payload: ResourceEventPayload): Promise<void> {
    const { challengeId, id: resourceId } = payload;

    if (!challengeId) {
      this.logger.warn('Resource created event missing challengeId.', payload);
      return;
    }

    try {
      const resource = await this.resourcesService.getResourceById(resourceId);
      const roleName = resource?.roleName
        ? resource.roleName.trim()
        : await this.resourcesService.getRoleNameById(payload.roleId);

      if (resource && resource.challengeId !== challengeId) {
        this.logger.warn(
          `Resource ${resourceId} reported for challenge ${challengeId}, but database indicates challenge ${resource.challengeId}. Proceeding with payload challenge ID.`,
        );
      }

      if (!roleName) {
        this.logger.warn(
          `Unable to determine role name for resource ${resourceId} on challenge ${challengeId}.`,
        );
      }

      if (roleName && !this.isReviewRole(roleName)) {
        this.logger.debug(
          `Ignoring resource ${resourceId} with non-review role ${roleName} for challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.first2FinishService.isChallengeActive(challenge.status)) {
        this.logger.debug(
          `Skipping resource create for challenge ${challengeId} with status ${challenge.status}.`,
        );
        return;
      }

      const openReviewPhases = challenge.phases?.filter(
        (phase) =>
          phase.isOpen &&
          REVIEW_PHASE_NAMES.has(phase.name) &&
          phase.name !== ITERATIVE_REVIEW_PHASE_NAME,
      );

      if (openReviewPhases?.length) {
        for (const phase of openReviewPhases) {
          try {
            await this.phaseReviewService.handlePhaseOpened(
              challengeId,
              phase.id,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to synchronize pending reviews for phase ${phase.id} on challenge ${challengeId} after resource creation: ${err.message}`,
              err.stack,
            );
          }
        }
      }

      if (
        roleName &&
        this.first2FinishService.isFirst2FinishChallenge(challenge.type) &&
        this.iterativeRoles.includes(roleName)
      ) {
        await this.first2FinishService.handleIterativeReviewerAdded(challenge);
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle resource creation for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleResourceDeleted(payload: ResourceEventPayload): Promise<void> {
    const { challengeId, id: resourceId } = payload;

    if (!challengeId) {
      this.logger.warn('Resource deleted event: Missing challengeId.', payload);
      return;
    }

    try {
      const roleName = await this.resourcesService.getRoleNameById(
        payload.roleId,
      );

      if (roleName && !this.isReviewRole(roleName)) {
        this.logger.debug(
          `Ignoring resource ${resourceId} deletion for non-review role ${roleName} on challenge ${challengeId}.`,
        );
        return;
      }

      const challenge =
        await this.challengeApiService.getChallengeById(challengeId);

      if (!this.first2FinishService.isChallengeActive(challenge.status)) {
        return;
      }

      const reviewPhases = challenge.phases?.filter((phase) =>
        REVIEW_PHASE_NAMES.has(phase.name),
      );

      if (reviewPhases?.length) {
        for (const phase of reviewPhases) {
          try {
            await this.reviewService.deletePendingReviewsForResource(
              phase.id,
              resourceId,
              challengeId,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to delete pending reviews for phase ${phase.id} on challenge ${challengeId}: ${err.message}`,
              err.stack,
            );
          }

          await this.reviewAssignmentService.handleReviewerRemoved(
            challengeId,
            {
              id: phase.id,
              phaseId: phase.phaseId,
              name: phase.name,
            },
          );
        }
      }

      if (
        roleName &&
        this.first2FinishService.isFirst2FinishChallenge(challenge.type) &&
        this.iterativeRoles.includes(roleName)
      ) {
        this.logger.warn(
          `Iterative reviewer removed from challenge ${challengeId}; awaiting reassignment before continuing F2F processing.`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to handle resource deletion for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }
  }

  private computeReviewRoleNames(postMortemRoles: string[]): Set<string> {
    const roles = new Set<string>();
    for (const names of Object.values(PHASE_ROLE_MAP)) {
      for (const name of names) {
        roles.add(name);
      }
    }
    postMortemRoles.forEach((role) => roles.add(role));
    return roles;
  }

  private isReviewRole(roleName?: string | null): boolean {
    if (!roleName) {
      return false;
    }
    return this.reviewRoleNames.has(roleName);
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
}
