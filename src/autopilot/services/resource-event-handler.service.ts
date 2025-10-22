import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  AutopilotOperator,
  ResourceEventPayload,
} from '../interfaces/autopilot.interface';
import {
  ITERATIVE_REVIEW_PHASE_NAME,
  POST_MORTEM_REVIEWER_ROLE_NAME,
  PHASE_ROLE_MAP,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
} from '../constants/review.constants';
import { First2FinishService } from './first2finish.service';
import { SchedulerService } from './scheduler.service';
import {
  getNormalizedStringArray,
  isActiveStatus,
} from '../utils/config.utils';

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
    private readonly schedulerService: SchedulerService,
  ) {
    const configuredPostMortemRoles = getNormalizedStringArray(
      this.configService.get('autopilot.postMortemRoles'),
      [POST_MORTEM_REVIEWER_ROLE_NAME],
    );
    const postMortemRoles = Array.from(
      new Set<string>([
        POST_MORTEM_REVIEWER_ROLE_NAME,
        ...configuredPostMortemRoles,
      ]),
    );
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
        : (await this.resourcesService.getRoleNameById(payload.roleId))?.trim();

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

      if (!isActiveStatus(challenge.status)) {
        this.logger.debug(
          `Skipping resource create for challenge ${challengeId} with status ${challenge.status}.`,
        );
        return;
      }

      if (roleName === 'Approver') {
        const approvalPhases =
          challenge.phases?.filter(
            (phase) => phase.isOpen && APPROVAL_PHASE_NAMES.has(phase.name),
          ) ?? [];

        for (const phase of approvalPhases) {
          try {
            const reassigned =
              await this.reviewService.reassignPendingReviewsToResource(
                phase.id,
                resourceId,
                challengeId,
              );

            if (reassigned > 0) {
              this.logger.log(
                `Reassigned ${reassigned} pending Approval review(s) on challenge ${challengeId} to resource ${resourceId}.`,
              );
            } else {
              this.logger.debug(
                `No pending Approval reviews required reassignment for challenge ${challengeId}, phase ${phase.id}.`,
              );
            }
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to reassign pending Approval reviews for challenge ${challengeId}, phase ${phase.id}: ${err.message}`,
              err.stack,
            );
          }
        }
      }

      await this.maybeOpenDeferredReviewPhases(challenge);

      // Sync pending reviews for any open Review or Screening phases
      const openReviewPhases = challenge.phases?.filter(
        (phase) =>
          phase.isOpen &&
          (REVIEW_PHASE_NAMES.has(phase.name) ||
            SCREENING_PHASE_NAMES.has(phase.name)) &&
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

      if (!isActiveStatus(challenge.status)) {
        return;
      }

      const reviewPhases = challenge.phases?.filter(
        (phase) => REVIEW_PHASE_NAMES.has(phase.name) || SCREENING_PHASE_NAMES.has(phase.name),
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

  private async maybeOpenDeferredReviewPhases(
    challenge: Awaited<ReturnType<ChallengeApiService['getChallengeById']>>,
  ): Promise<void> {
    const reviewPhases = challenge.phases ?? [];
    if (!reviewPhases.length) {
      return;
    }

    const now = Date.now();

    for (const phase of reviewPhases) {
      if (
        phase.isOpen ||
        !!phase.actualEndDate ||
        phase.name === ITERATIVE_REVIEW_PHASE_NAME ||
        !REVIEW_PHASE_NAMES.has(phase.name)
      ) {
        continue;
      }

      if (phase.scheduledStartDate) {
        const scheduledStart = new Date(phase.scheduledStartDate).getTime();
        if (Number.isFinite(scheduledStart) && scheduledStart > now) {
          continue;
        }
      }

      if (phase.predecessor) {
        const predecessor = reviewPhases.find(
          (candidate) =>
            candidate.phaseId === phase.predecessor ||
            candidate.id === phase.predecessor,
        );

        if (!predecessor?.actualEndDate) {
          continue;
        }
      }

      const openPhaseCallback = async (): Promise<boolean> => {
        await this.schedulerService.advancePhase({
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          state: 'START',
          operator: AutopilotOperator.SYSTEM,
          projectStatus: challenge.status,
        });
        return true;
      };

      let ready = false;
      try {
        ready = await this.reviewAssignmentService.ensureAssignmentsOrSchedule(
          challenge.id,
          phase,
          openPhaseCallback,
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed to verify reviewer assignments for phase ${phase.id} on challenge ${challenge.id}: ${err.message}`,
          err.stack,
        );
        continue;
      }

      if (!phase.isOpen && ready) {
        try {
          await openPhaseCallback();
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to auto-open review phase ${phase.id} on challenge ${challenge.id}: ${err.message}`,
            err.stack,
          );
        }
      }
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
}
