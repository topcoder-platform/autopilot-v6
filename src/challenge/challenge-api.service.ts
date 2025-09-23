import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import { ChallengePrismaService } from './challenge-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import {
  IPhase,
  IChallenge,
  IChallengeWinner,
} from './interfaces/challenge.interface';

// DTO for filtering challenges
interface ChallengeFiltersDto {
  status?: string;
  isLightweight?: boolean;
  page?: number;
  perPage?: number;
}

// DTO for the response of the advance-phase operation
interface PhaseAdvanceResponseDto {
  success: boolean;
  message: string;
  hasWinningSubmission?: boolean;
  updatedPhases?: IPhase[];
  next?: {
    operation?: 'open' | 'close';
    phases?: IPhase[];
  };
}

const challengeWithRelationsArgs =
  Prisma.validator<Prisma.ChallengeDefaultArgs>()({
    include: {
      phases: {
        include: { constraints: true },
        orderBy: { scheduledStartDate: 'asc' as const },
      },
      winners: true,
      track: true,
      type: true,
      legacyRecord: true,
      reviewers: true,
    },
  });

type ChallengeWithRelations = Prisma.ChallengeGetPayload<
  typeof challengeWithRelationsArgs
>;

type ChallengePhaseWithConstraints = ChallengeWithRelations['phases'][number];

@Injectable()
export class ChallengeApiService {
  private readonly logger = new Logger(ChallengeApiService.name);
  private readonly defaultPageSize = 50;

  constructor(
    private readonly prisma: ChallengePrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  async getAllActiveChallenges(
    filters: ChallengeFiltersDto = {},
  ): Promise<IChallenge[]> {
    const where: Prisma.ChallengeWhereInput = {
      status: ChallengeStatusEnum.ACTIVE,
    };

    if (filters.status) {
      where.status = filters.status as ChallengeStatusEnum;
    }

    const shouldPaginate =
      typeof filters.page === 'number' || typeof filters.perPage === 'number';
    const perPage = filters.perPage ?? this.defaultPageSize;
    const page = filters.page ?? 1;
    try {
      const challenges = await this.prisma.challenge.findMany({
        ...challengeWithRelationsArgs,
        where,
        ...(shouldPaginate
          ? {
              skip: Math.max(page - 1, 0) * perPage,
              take: perPage,
            }
          : {}),
        orderBy: { updatedAt: 'desc' },
      });

      const mapped = challenges.map((challenge) => this.mapChallenge(challenge));

      void this.dbLogger.logAction('challenge.getAllActiveChallenges', {
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          filters: {
            status: filters.status ?? null,
            isLightweight: filters.isLightweight ?? null,
            page,
            perPage,
          },
          resultCount: mapped.length,
        },
      });

      return mapped;
    } catch (error) {
      const err = error as Error;

      void this.dbLogger.logAction('challenge.getAllActiveChallenges', {
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          filters: {
            status: filters.status ?? null,
            isLightweight: filters.isLightweight ?? null,
            page,
            perPage,
          },
          error: err.message,
        },
      });

      throw err;
    }
  }

  async getChallenge(challengeId: string): Promise<IChallenge | null> {
    this.logger.debug(`Fetching challenge with ID: ${challengeId}`);
    try {
      const challenge = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      if (!challenge) {
        void this.dbLogger.logAction('challenge.getChallenge', {
          challengeId,
          status: 'SUCCESS',
          source: ChallengeApiService.name,
          details: { found: false },
        });
        return null;
      }

      const mapped = this.mapChallenge(challenge);

      void this.dbLogger.logAction('challenge.getChallenge', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          found: true,
          phaseCount: mapped.phases?.length ?? 0,
        },
      });

      return mapped;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.getChallenge', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: { error: err.message },
      });
      throw err;
    }
  }

  /**
   * Retrieves a specific challenge by its ID.
   * This method fetches challenge details but does not verify if the challenge is active.
   */
  async getChallengeById(challengeId: string): Promise<IChallenge> {
    const challenge = await this.getChallenge(challengeId);
    if (!challenge) {
      throw new NotFoundException(
        `Challenge with ID ${challengeId} not found.`,
      );
    }
    return challenge;
  }

  async getChallengePhases(challengeId: string): Promise<IPhase[]> {
    const challenge = await this.getChallenge(challengeId);
    const phases = challenge?.phases || [];

    void this.dbLogger.logAction('challenge.getChallengePhases', {
      challengeId,
      status: 'SUCCESS',
      source: ChallengeApiService.name,
      details: { phaseCount: phases.length },
    });

    return phases;
  }

  async getPhaseDetails(
    challengeId: string,
    phaseId: string,
  ): Promise<IPhase | null> {
    const phases = await this.getChallengePhases(challengeId);
    const phase = phases.find((p) => p.id === phaseId) || null;

    void this.dbLogger.logAction('challenge.getPhaseDetails', {
      challengeId,
      status: 'SUCCESS',
      source: ChallengeApiService.name,
      details: {
        phaseId,
        found: Boolean(phase),
      },
    });

    return phase;
  }

  async getPhaseTypeName(
    challengeId: string,
    phaseId: string,
  ): Promise<string> {
    const phase = await this.getPhaseDetails(challengeId, phaseId);
    const name = phase?.name || 'Unknown';

    void this.dbLogger.logAction('challenge.getPhaseTypeName', {
      challengeId,
      status: 'SUCCESS',
      source: ChallengeApiService.name,
      details: {
        phaseId,
        phaseName: name,
      },
    });

    return name;
  }

  async advancePhase(
    challengeId: string,
    phaseId: string,
    operation: 'open' | 'close',
  ): Promise<PhaseAdvanceResponseDto> {
    this.logger.debug(
      `Attempting to ${operation} phase ${phaseId} for challenge ${challengeId}`,
    );
    try {
      const challenge = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      if (!challenge) {
        this.logger.warn(
          `Challenge ${challengeId} not found when advancing phase.`,
        );
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Challenge ${challengeId} not found`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      if (challenge.status !== ChallengeStatusEnum.ACTIVE) {
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Challenge ${challengeId} is not active (status: ${challenge.status}).`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      const targetPhase = challenge.phases.find((phase) => phase.id === phaseId);

      if (!targetPhase) {
        this.logger.warn(
          `Phase ${phaseId} not found in challenge ${challengeId} while attempting to ${operation}.`,
        );
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Phase ${phaseId} not found in challenge ${challengeId}`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      if (operation === 'open' && targetPhase.isOpen) {
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Phase ${targetPhase.name} is already open`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      if (operation === 'close' && !targetPhase.isOpen) {
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Phase ${targetPhase.name} is already closed`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      const now = new Date();
      const currentPhaseNames = new Set<string>(
        challenge.currentPhaseNames || [],
      );

      try {
        await this.prisma.$transaction(async (tx) => {
          if (operation === 'open') {
            currentPhaseNames.add(targetPhase.name);
            await tx.challengePhase.update({
              where: { id: targetPhase.id },
              data: {
                isOpen: true,
                actualStartDate: targetPhase.actualStartDate ?? now,
                actualEndDate: null,
              },
            });
          } else {
            currentPhaseNames.delete(targetPhase.name);
            await tx.challengePhase.update({
              where: { id: targetPhase.id },
              data: {
                isOpen: false,
                actualEndDate: targetPhase.actualEndDate ?? now,
              },
            });
          }

          await tx.challenge.update({
            where: { id: challengeId },
            data: {
              currentPhaseNames: Array.from(currentPhaseNames),
            },
          });
        });
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed to ${operation} phase ${phaseId} for challenge ${challengeId}: ${err.message}`,
          err.stack,
        );
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Failed to ${operation} phase`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'ERROR',
          source: ChallengeApiService.name,
          details: { phaseId, operation, error: err.message },
        });
        return result;
      }

      const updatedChallenge = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      if (!updatedChallenge) {
        const result: PhaseAdvanceResponseDto = {
          success: true,
          message: `Phase ${targetPhase.name} ${operation}d but failed to reload challenge`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: { phaseId, operation, result },
        });
        return result;
      }

      const hasWinningSubmission = (updatedChallenge.winners || []).length > 0;

      const updatedPhases = updatedChallenge.phases.map((phase) =>
        this.mapPhase(phase),
      );

      let nextPhases: IPhase[] | undefined;

      if (operation === 'close') {
        const successors = updatedChallenge.phases.filter((phase) => {
          if (!phase.predecessor) {
            return false;
          }

          const predecessorMatches =
            phase.predecessor === targetPhase.phaseId ||
            phase.predecessor === targetPhase.id;

          return predecessorMatches && !phase.actualEndDate && !phase.isOpen;
        });

        if (successors.length > 0) {
          nextPhases = successors.map((phase) => this.mapPhase(phase));
        }
      }

      const result: PhaseAdvanceResponseDto = {
        success: true,
        hasWinningSubmission,
        message: `Successfully ${operation}d phase ${targetPhase.name} for challenge ${challengeId}`,
        updatedPhases,
        next: nextPhases
          ? {
              operation: 'open',
              phases: nextPhases,
            }
          : undefined,
      };

      void this.dbLogger.logAction('challenge.advancePhase', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          phaseId,
          operation,
          hasWinningSubmission,
          nextPhaseCount: nextPhases?.length ?? 0,
        },
      });

      return result;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.advancePhase', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          phaseId,
          operation,
          error: err.message,
        },
      });
      throw err;
    }
  }

  private mapChallenge(challenge: ChallengeWithRelations): IChallenge {
    return {
      id: challenge.id,
      name: challenge.name,
      description: challenge.description ?? null,
      descriptionFormat: challenge.descriptionFormat ?? 'markdown',
      projectId: challenge.projectId ?? 0,
      typeId: challenge.typeId,
      trackId: challenge.trackId,
      timelineTemplateId: challenge.timelineTemplateId ?? '',
      currentPhaseNames: challenge.currentPhaseNames ?? [],
      tags: challenge.tags ?? [],
      groups: challenge.groups ?? [],
      submissionStartDate: this.ensureTimestamp(challenge.submissionStartDate),
      submissionEndDate: this.ensureTimestamp(challenge.submissionEndDate),
      registrationStartDate: this.ensureTimestamp(
        challenge.registrationStartDate,
      ),
      registrationEndDate: this.ensureTimestamp(challenge.registrationEndDate),
      startDate: this.ensureTimestamp(challenge.startDate),
      endDate: this.optionalTimestamp(challenge.endDate),
      legacyId: challenge.legacyId ?? null,
      status: challenge.status,
      createdBy: challenge.createdBy,
      updatedBy: challenge.updatedBy,
      metadata: [],
      phases: challenge.phases.map((phase) => this.mapPhase(phase)),
      reviewers:
        challenge.reviewers?.map((reviewer) => this.mapReviewer(reviewer)) ||
        [],
      winners: challenge.winners?.map((winner) => this.mapWinner(winner)) || [],
      discussions: [],
      events: [],
      prizeSets: [],
      terms: [],
      skills: [],
      attachments: [],
      track: challenge.track?.name ?? '',
      type: challenge.type?.name ?? '',
      legacy: challenge.legacyRecord
        ? {
            reviewType: challenge.legacyRecord.reviewType,
            confidentialityType: challenge.legacyRecord.confidentialityType,
            forumId: challenge.legacyRecord.forumId,
            directProjectId: challenge.legacyRecord.directProjectId,
            screeningScorecardId: challenge.legacyRecord.screeningScorecardId,
            reviewScorecardId: challenge.legacyRecord.reviewScorecardId,
            isTask: challenge.legacyRecord.isTask,
            useSchedulingAPI: challenge.legacyRecord.useSchedulingAPI,
            pureV5Task: challenge.legacyRecord.pureV5Task,
            pureV5: challenge.legacyRecord.pureV5,
            selfService: challenge.legacyRecord.selfService,
            selfServiceCopilot: challenge.legacyRecord.selfServiceCopilot,
            track: challenge.legacyRecord.track,
            subTrack: challenge.legacyRecord.subTrack,
            legacySystemId: challenge.legacyRecord.legacySystemId,
          }
        : {},
      task: {
        isTask: challenge.taskIsTask,
        isAssigned: challenge.taskIsAssigned,
        memberId: challenge.taskMemberId,
      },
      created: challenge.createdAt.toISOString(),
      updated: challenge.updatedAt.toISOString(),
      overview: {
        totalPrizes: challenge.overviewTotalPrizes ?? 0,
      },
      numOfSubmissions: challenge.numOfSubmissions,
      numOfCheckpointSubmissions: challenge.numOfCheckpointSubmissions,
      numOfRegistrants: challenge.numOfRegistrants,
    };
  }

  private mapPhase(phase: ChallengePhaseWithConstraints): IPhase {
    return {
      id: phase.id,
      phaseId: phase.phaseId,
      name: phase.name,
      description: phase.description ?? null,
      isOpen: phase.isOpen ?? false,
      duration: phase.duration ?? 0,
      scheduledStartDate: this.ensureTimestamp(phase.scheduledStartDate),
      scheduledEndDate: this.ensureTimestamp(phase.scheduledEndDate),
      actualStartDate: this.optionalTimestamp(phase.actualStartDate),
      actualEndDate: this.optionalTimestamp(phase.actualEndDate),
      predecessor: phase.predecessor ?? null,
      constraints:
        phase.constraints?.map((constraint) => ({
          id: constraint.id,
          name: constraint.name,
          value: constraint.value,
        })) ?? [],
    };
  }

  private mapReviewer(reviewer: ChallengeWithRelations['reviewers'][number]) {
    return {
      id: reviewer.id,
      scorecardId: reviewer.scorecardId,
      isMemberReview: reviewer.isMemberReview,
      memberReviewerCount: reviewer.memberReviewerCount ?? null,
      phaseId: reviewer.phaseId,
      basePayment: reviewer.basePayment ?? null,
      incrementalPayment: reviewer.incrementalPayment ?? null,
      type: reviewer.type ?? null,
      aiWorkflowId: reviewer.aiWorkflowId ?? null,
    };
  }

  private mapWinner(
    winner: ChallengeWithRelations['winners'][number],
  ): IChallengeWinner {
    return {
      userId: winner.userId,
      handle: winner.handle,
      placement: winner.placement,
      type: winner.type,
    };
  }

  async completeChallenge(
    challengeId: string,
    winners: IChallengeWinner[],
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.challenge.update({
          where: { id: challengeId },
          data: { status: ChallengeStatusEnum.COMPLETED },
        });

        await tx.challengeWinner.deleteMany({ where: { challengeId } });

        if (winners.length) {
          await tx.challengeWinner.createMany({
            data: winners.map((winner) => ({
              challengeId,
              userId: winner.userId,
              handle: winner.handle,
              placement: winner.placement,
              type: PrizeSetTypeEnum.PLACEMENT,
              createdBy: 'Autopilot',
              updatedBy: 'Autopilot',
            })),
          });
        }
      });

      void this.dbLogger.logAction('challenge.completeChallenge', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: { winnersCount: winners.length },
      });
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.completeChallenge', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: { winnersCount: winners.length, error: err.message },
      });
      throw err;
    }
  }

  private ensureTimestamp(date?: Date | null): string {
    return date ? date.toISOString() : new Date(0).toISOString();
  }

  private optionalTimestamp(date?: Date | null): string | null {
    return date ? date.toISOString() : null;
  }
}
