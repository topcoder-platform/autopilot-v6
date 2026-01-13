import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ChallengePrismaService } from './challenge-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import {
  IPhase,
  IChallenge,
  IChallengeWinner,
  IChallengePrizeSet,
} from './interfaces/challenge.interface';
import {
  DEFAULT_APPEALS_PHASE_NAMES,
  DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
  ITERATIVE_REVIEW_PHASE_NAME,
  POST_MORTEM_PHASE_NAMES,
  isPostMortemPhaseName,
} from '../autopilot/constants/review.constants';

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
      metadata: true,
      winners: true,
      skills: true,
      prizeSets: {
        include: { prizes: true },
      },
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
type ChallengePrizeSetWithPrizes = ChallengeWithRelations['prizeSets'][number];

@Injectable()
export class ChallengeApiService {
  private readonly logger = new Logger(ChallengeApiService.name);
  private readonly defaultPageSize = 50;
  private readonly appealsPhaseNames: Set<string>;
  private readonly appealsResponsePhaseNames: Set<string>;
  private readonly checkpointWinnerQueryLogIds = new Set<string>();
  private checkpointWinnerQueryLoggerAttached = false;

  constructor(
    private readonly prisma: ChallengePrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
    private readonly configService: ConfigService,
  ) {
    this.appealsPhaseNames = this.buildPhaseNameSet(
      this.configService.get('autopilot.appealsPhaseNames'),
      DEFAULT_APPEALS_PHASE_NAMES,
    );
    this.appealsResponsePhaseNames = this.buildPhaseNameSet(
      this.configService.get('autopilot.appealsResponsePhaseNames'),
      DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
    );
    this.attachCheckpointWinnerQueryLogger();
  }

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

      const mapped = challenges.map((challenge) =>
        this.mapChallenge(challenge),
      );

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

      const targetPhase = challenge.phases.find(
        (phase) => phase.id === phaseId,
      );

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
      const scheduledStartDate = targetPhase.scheduledStartDate
        ? new Date(targetPhase.scheduledStartDate)
        : null;
      const scheduledEndDate = targetPhase.scheduledEndDate
        ? new Date(targetPhase.scheduledEndDate)
        : null;
      const durationSeconds = this.computePhaseDurationSeconds(targetPhase);
      const isAppealsPhase = this.isAppealsPhaseName(targetPhase.name);
      const isOpeningLateAppeals =
        operation === 'open' &&
        isAppealsPhase &&
        durationSeconds !== null &&
        scheduledStartDate !== null &&
        now.getTime() - scheduledStartDate.getTime() > 1000;
      const isOpeningEarly =
        operation === 'open' &&
        durationSeconds !== null &&
        scheduledStartDate !== null &&
        scheduledStartDate.getTime() - now.getTime() > 1000;
      const isOpeningAfterScheduledEnd =
        operation === 'open' &&
        durationSeconds !== null &&
        scheduledEndDate !== null &&
        now.getTime() - scheduledEndDate.getTime() > 1000;

      const minimumEndTime =
        durationSeconds !== null
          ? now.getTime() + durationSeconds * 1000
          : null;
      const openedLate =
        operation === 'open' &&
        scheduledStartDate !== null &&
        now.getTime() - scheduledStartDate.getTime() > 1000;
      const hasInsufficientRemainingDuration =
        openedLate &&
        minimumEndTime !== null &&
        (scheduledEndDate === null ||
          scheduledEndDate.getTime() < minimumEndTime);

      let shouldAdjustSchedule = false;
      let adjustedEndDate: Date | null = null;

      if (
        minimumEndTime !== null &&
        (isOpeningEarly || isOpeningLateAppeals || isOpeningAfterScheduledEnd)
      ) {
        shouldAdjustSchedule = true;
        adjustedEndDate = new Date(minimumEndTime);
      }

      if (minimumEndTime !== null && hasInsufficientRemainingDuration) {
        shouldAdjustSchedule = true;
        if (!adjustedEndDate || adjustedEndDate.getTime() < minimumEndTime) {
          adjustedEndDate = new Date(minimumEndTime);
        }
      }

      if (isOpeningLateAppeals && adjustedEndDate) {
        this.logger.log(
          `Extending appeals phase ${targetPhase.id} to preserve duration. New end: ${adjustedEndDate.toISOString()}.`,
        );
      }

      if (isOpeningAfterScheduledEnd && adjustedEndDate && !isAppealsPhase) {
        this.logger.log(
          `Extending phase ${targetPhase.id} (${targetPhase.name}) opened after its scheduled end. New end: ${adjustedEndDate.toISOString()}.`,
        );
      }

      if (
        hasInsufficientRemainingDuration &&
        adjustedEndDate &&
        !isOpeningLateAppeals &&
        !isOpeningAfterScheduledEnd
      ) {
        this.logger.log(
          `Extending phase ${targetPhase.id} (${targetPhase.name}) opened late to preserve configured duration (${durationSeconds}s). New end: ${adjustedEndDate.toISOString()}.`,
        );
      }

      let phaseUpdated = false;
      try {
        await this.prisma.$transaction(async (tx) => {
          if (operation === 'open') {
            const updateResult = await tx.challengePhase.updateMany({
              where: {
                id: targetPhase.id,
                isOpen: false,
              },
              data: {
                isOpen: true,
                actualStartDate: targetPhase.actualStartDate ?? now,
                actualEndDate: null,
                ...(shouldAdjustSchedule
                  ? {
                      scheduledStartDate: now,
                      scheduledEndDate: adjustedEndDate!,
                      duration: durationSeconds!,
                    }
                  : {}),
              },
            });

            if (updateResult.count === 0) {
              return;
            }

            phaseUpdated = true;
            currentPhaseNames.add(targetPhase.name);
          } else {
            const updateResult = await tx.challengePhase.updateMany({
              where: {
                id: targetPhase.id,
                isOpen: true,
              },
              data: {
                isOpen: false,
                actualEndDate: targetPhase.actualEndDate ?? now,
              },
            });

            if (updateResult.count === 0) {
              return;
            }

            phaseUpdated = true;
            currentPhaseNames.delete(targetPhase.name);
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

      if (!phaseUpdated) {
        const result: PhaseAdvanceResponseDto = {
          success: false,
          message: `Phase ${targetPhase.name} is already ${
            operation === 'open' ? 'open' : 'closed'
          }`,
        };
        void this.dbLogger.logAction('challenge.advancePhase', {
          challengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: {
            phaseId,
            operation,
            result,
            note: 'Skipped update because phase state changed during transaction.',
          },
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
          scheduleAdjusted: shouldAdjustSchedule,
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

  async rescheduleSuccessorPhases(
    challengeId: string,
    predecessorPhaseId: string,
  ): Promise<void> {
    if (!challengeId || !predecessorPhaseId) {
      return;
    }

    let updatedCount = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        const phases = await tx.challengePhase.findMany({
          where: { challengeId },
          include: { constraints: true },
        });

        const predecessorPhase = phases.find(
          (phase) => phase.id === predecessorPhaseId,
        );

        if (!predecessorPhase || !predecessorPhase.scheduledEndDate) {
          return;
        }

        const successorsByPredecessor = new Map<
          string,
          ChallengePhaseWithConstraints[]
        >();
        for (const phase of phases) {
          if (!phase.predecessor) {
            continue;
          }
          const key = String(phase.predecessor);
          const list = successorsByPredecessor.get(key);
          if (list) {
            list.push(phase);
          } else {
            successorsByPredecessor.set(key, [phase]);
          }
        }

        const queue: ChallengePhaseWithConstraints[] = [predecessorPhase];
        const visited = new Set<string>();

        while (queue.length > 0) {
          const currentPhase = queue.shift();
          if (!currentPhase?.scheduledEndDate) {
            continue;
          }

          const predecessorKeys = this.buildPhaseIdentifiers(currentPhase);
          for (const predecessorKey of predecessorKeys) {
            const successors = successorsByPredecessor.get(predecessorKey) || [];
            for (const successor of successors) {
              if (visited.has(successor.id)) {
                continue;
              }

              let successorForQueue = successor;
              if (!successor.actualStartDate) {
                const durationSeconds =
                  this.computePhaseDurationSeconds(successor);
                const alignToPredecessorStart =
                  this.isIterativeReviewPhaseName(successor.name);
                const desiredStartSource =
                  alignToPredecessorStart && currentPhase.scheduledStartDate
                    ? currentPhase.scheduledStartDate
                    : currentPhase.scheduledEndDate;

                if (
                  typeof durationSeconds === 'number' &&
                  durationSeconds > 0 &&
                  desiredStartSource
                ) {
                  const desiredStartDate = new Date(desiredStartSource);
                  const desiredEndDate = new Date(
                    desiredStartDate.getTime() + durationSeconds * 1000,
                  );

                  const startChanged = !this.datesAreSame(
                    successor.scheduledStartDate,
                    desiredStartDate,
                  );
                  const endChanged = !this.datesAreSame(
                    successor.scheduledEndDate,
                    desiredEndDate,
                  );

                  if (startChanged || endChanged) {
                    successorForQueue = await tx.challengePhase.update({
                      where: { id: successor.id },
                      data: {
                        scheduledStartDate: desiredStartDate,
                        scheduledEndDate: desiredEndDate,
                      },
                      include: { constraints: true },
                    });
                    updatedCount += 1;
                  } else {
                    successorForQueue = {
                      ...successor,
                      scheduledStartDate: successor.scheduledStartDate,
                      scheduledEndDate: successor.scheduledEndDate,
                    };
                  }
                }
              }

              visited.add(successor.id);
              queue.push(successorForQueue);
            }
          }
        }
      });

      if (updatedCount > 0) {
        this.logger.log(
          `Rescheduled ${updatedCount} successor phase(s) for challenge ${challengeId} after updating phase ${predecessorPhaseId}.`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to reschedule successor phases for challenge ${challengeId} after phase ${predecessorPhaseId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private computePhaseDurationSeconds(
    phase: ChallengePhaseWithConstraints,
  ): number | null {
    if (typeof phase.duration === 'number' && phase.duration > 0) {
      return phase.duration;
    }

    if (phase.scheduledStartDate && phase.scheduledEndDate) {
      const startMs = new Date(phase.scheduledStartDate).getTime();
      const endMs = new Date(phase.scheduledEndDate).getTime();
      const diffSeconds = Math.round((endMs - startMs) / 1000);

      if (Number.isFinite(diffSeconds) && diffSeconds > 0) {
        return diffSeconds;
      }
    }

    return null;
  }

  private datesAreSame(
    dateA?: string | Date | null,
    dateB?: string | Date | null,
  ): boolean {
    if (!dateA && !dateB) {
      return true;
    }
    if (!dateA || !dateB) {
      return false;
    }
    return new Date(dateA).getTime() === new Date(dateB).getTime();
  }

  private buildPhaseIdentifiers(
    phase: ChallengePhaseWithConstraints,
  ): string[] {
    const identifiers: string[] = [];
    if (phase.id) {
      identifiers.push(String(phase.id));
    }
    if (phase.phaseId) {
      identifiers.push(String(phase.phaseId));
    }
    return identifiers;
  }

  private isIterativeReviewPhaseName(
    phaseName?: string | null,
  ): boolean {
    const normalized = phaseName?.trim();
    if (!normalized) {
      return false;
    }
    return (
      normalized.toLowerCase() ===
      ITERATIVE_REVIEW_PHASE_NAME.toLowerCase()
    );
  }

  private buildPhaseNameSet(
    source: unknown,
    fallback: Set<string>,
  ): Set<string> {
    const resolved = this.normalizeStringArray(source, Array.from(fallback));
    return new Set(
      resolved
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }

  private normalizeStringArray(
    source: unknown,
    fallback: string[],
  ): string[] {
    if (Array.isArray(source)) {
      const normalized = source
        .map((item) =>
          typeof item === 'string' ? item.trim() : String(item ?? '').trim(),
        )
        .filter((item) => item.length > 0);

      if (normalized.length > 0) {
        return normalized;
      }
    }

    if (typeof source === 'string' && source.length > 0) {
      const normalized = source
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (normalized.length > 0) {
        return normalized;
      }
    }

    return fallback;
  }

  private isAppealsPhaseName(phaseName?: string | null): boolean {
    const normalized = phaseName?.trim();
    if (!normalized) {
      return false;
    }

    return (
      this.appealsPhaseNames.has(normalized) ||
      this.appealsResponsePhaseNames.has(normalized)
    );
  }

  private mapChallenge(challenge: ChallengeWithRelations): IChallenge {
    const metadata = (challenge.metadata ?? []).reduce<
      Record<string, string>
    >((acc, entry) => {
      const key = entry?.name?.trim();
      if (!key) {
        return acc;
      }

      acc[key] = entry.value ?? '';
      return acc;
    }, {});

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
      metadata,
      phases: challenge.phases.map((phase) => this.mapPhase(phase)),
      reviewers:
        challenge.reviewers?.map((reviewer) => this.mapReviewer(reviewer)) ||
        [],
      winners: challenge.winners?.map((winner) => this.mapWinner(winner)) || [],
      discussions: [],
      events: [],
      prizeSets:
        challenge.prizeSets?.map((prizeSet) => this.mapPrizeSet(prizeSet)) || [],
      terms: [],
      skills:
        challenge.skills?.map((skill) => ({ id: skill.skillId })) || [],
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
      fixedAmount: reviewer.fixedAmount ?? 0,
      baseCoefficient: reviewer.baseCoefficient ?? null,
      incrementalCoefficient: reviewer.incrementalCoefficient ?? null,
      type: reviewer.type ?? null,
      aiWorkflowId: reviewer.aiWorkflowId ?? null,
      shouldOpenOpportunity:
        reviewer.shouldOpenOpportunity === false ? false : true,
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

  private mapPrizeSet(
    prizeSet: ChallengePrizeSetWithPrizes,
  ): IChallengePrizeSet {
    return {
      type: prizeSet.type,
      description: prizeSet.description ?? null,
      prizes:
        prizeSet.prizes?.map((prize) => ({
          type: prize.type,
          value: prize.value,
          description: prize.description ?? null,
        })) ?? [],
    };
  }

  async createPostMortemPhase(
    challengeId: string,
    submissionPhaseId: string,
    durationHours: number,
  ): Promise<IPhase> {
    const now = new Date();
    const clampedDurationSeconds = Math.max(
      Math.round((durationHours || 0) * 60 * 60),
      1,
    );
    const end = new Date(now.getTime() + clampedDurationSeconds * 1000);

    let reusedExisting = false;

    try {
      const { postMortemPhaseId } = await this.prisma.$transaction(
        async (tx) => {
          // Lock the challenge row to avoid concurrent duplicate creations.
          await tx.$queryRaw(Prisma.sql`
            SELECT 1
            FROM "Challenge"
            WHERE "id" = ${challengeId}
            FOR UPDATE
          `);

          const challenge = await tx.challenge.findUnique({
            ...challengeWithRelationsArgs,
            where: { id: challengeId },
          });

          if (!challenge) {
            throw new NotFoundException(
              `Challenge with ID ${challengeId} not found when creating post-mortem phase.`,
            );
          }

          const submissionPhaseIndex = challenge.phases.findIndex(
            (phase) => phase.id === submissionPhaseId,
          );

          if (submissionPhaseIndex === -1) {
            throw new NotFoundException(
              `Submission phase ${submissionPhaseId} not found for challenge ${challengeId}.`,
            );
          }

          const submissionPhase = challenge.phases[submissionPhaseIndex];

          const futurePhases = challenge.phases.slice(submissionPhaseIndex + 1);
          const postMortemPhases = futurePhases.filter((phase) =>
            isPostMortemPhaseName(phase.name),
          );
          const existingPostMortem = postMortemPhases[0] ?? null;

          if (postMortemPhases.length > 1) {
            this.logger.warn(
              `Detected ${postMortemPhases.length} Post-Mortem phases on challenge ${challengeId}; reusing the first and preserving the rest for manual reconciliation.`,
            );
          }

          const phasesToDelete = futurePhases
            .filter((phase) => !isPostMortemPhaseName(phase.name))
            .map((phase) => phase.id);

          if (phasesToDelete.length) {
            await tx.challengePhase.deleteMany({
              where: { id: { in: phasesToDelete } },
            });
          }

          if (existingPostMortem) {
            reusedExisting = true;
            await tx.challengePhase.update({
              where: { id: existingPostMortem.id },
              data: {
                predecessor: submissionPhase.phaseId ?? submissionPhase.id,
                duration: clampedDurationSeconds,
                scheduledStartDate: now,
                scheduledEndDate: end,
                actualStartDate: now,
                actualEndDate: null,
                isOpen: true,
                updatedBy: 'Autopilot',
              },
            });

            await tx.challenge.update({
              where: { id: challengeId },
              data: {
                currentPhaseNames: [existingPostMortem.name],
              },
            });

            return { postMortemPhaseId: existingPostMortem.id };
          }

          const postMortemPhaseType = await tx.phase.findFirst({
            where: { name: { in: Array.from(POST_MORTEM_PHASE_NAMES) } },
          });

          if (!postMortemPhaseType) {
            throw new NotFoundException(
              'Phase type "Post-Mortem" is not configured in the system.',
            );
          }

          const created = await tx.challengePhase.create({
            data: {
              challengeId,
              phaseId: postMortemPhaseType.id,
              name: postMortemPhaseType.name,
              description: postMortemPhaseType.description,
              predecessor: submissionPhase.phaseId ?? submissionPhase.id,
              duration: clampedDurationSeconds,
              scheduledStartDate: now,
              scheduledEndDate: end,
              actualStartDate: now,
              isOpen: true,
              createdBy: 'Autopilot',
              updatedBy: 'Autopilot',
            },
          });

          await tx.challenge.update({
            where: { id: challengeId },
            data: {
              currentPhaseNames: [postMortemPhaseType.name],
            },
          });

          return { postMortemPhaseId: created.id };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );

      const refreshed = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      const phaseRecord = refreshed?.phases.find(
        (phase) => phase.id === postMortemPhaseId,
      );

      if (!phaseRecord) {
        throw new Error(
          `Post-mortem phase ${postMortemPhaseId} not found after processing for challenge ${challengeId}.`,
        );
      }

      const mapped = this.mapPhase(phaseRecord);

      void this.dbLogger.logAction('challenge.createPostMortemPhase', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          submissionPhaseId,
          postMortemPhaseId: mapped.id,
          durationHours,
          reusedExisting,
        },
      });

      return mapped;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.createPostMortemPhase', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          submissionPhaseId,
          durationHours,
          reusedExisting,
          error: err.message,
        },
      });
      throw err;
    }
  }

  /**
   * Create a Post-Mortem phase without deleting any subsequent phases and without forcing it open.
   * Used for Topgear late submission flow where Post-Mortem must exist but only open later.
   */
  async createPostMortemPhasePreserving(
    challengeId: string,
    predecessorPhaseId: string,
    durationHours: number,
    openImmediately = false,
  ): Promise<IPhase> {
    const now = new Date();
    const end = new Date(now.getTime() + Math.max(durationHours, 1) * 60 * 60 * 1000);
    let closedApprovalPhaseCount = 0;

    try {
      const { createdPhaseId } = await this.prisma.$transaction(async (tx) => {
        const challenge = await tx.challenge.findUnique({
          ...challengeWithRelationsArgs,
          where: { id: challengeId },
        });

        if (!challenge) {
          throw new NotFoundException(
            `Challenge with ID ${challengeId} not found when creating post-mortem phase (preserving).`,
          );
        }

        const predecessorPhase = challenge.phases.find(
          (phase) => phase.id === predecessorPhaseId,
        );

        if (!predecessorPhase) {
          throw new NotFoundException(
            `Predecessor phase ${predecessorPhaseId} not found for challenge ${challengeId}.`,
          );
        }

        const updatedPhaseNames = new Set(challenge.currentPhaseNames ?? []);

        if (openImmediately) {
          const approvalsToClose = challenge.phases.filter(
            (phase) =>
              APPROVAL_PHASE_NAMES.has(phase.name) &&
              (phase.isOpen || !phase.actualEndDate),
          );

          if (approvalsToClose.length > 0) {
            closedApprovalPhaseCount = approvalsToClose.length;
            await tx.challengePhase.updateMany({
              where: { id: { in: approvalsToClose.map((phase) => phase.id) } },
              data: {
                isOpen: false,
                actualStartDate: now,
                actualEndDate: now,
                updatedBy: 'Autopilot',
              },
            });

            for (const approvalPhase of approvalsToClose) {
              updatedPhaseNames.delete(approvalPhase.name);
            }

            this.logger.log(
              `Closed ${approvalsToClose.length} Approval phase(s) prior to opening Post-Mortem for challenge ${challengeId}.`,
            );
          }
        }

        // If a Post-Mortem already exists, return it idempotently.
        const existing = challenge.phases.find((phase) =>
          isPostMortemPhaseName(phase.name),
        );
        if (existing) {
          return { createdPhaseId: existing.id };
        }

        const postMortemPhaseType = await tx.phase.findFirst({
          where: { name: { in: Array.from(POST_MORTEM_PHASE_NAMES) } },
        });

        if (!postMortemPhaseType) {
          throw new NotFoundException(
            'Phase type "Post-Mortem" is not configured in the system.',
          );
        }

        const created = await tx.challengePhase.create({
          data: {
            challengeId,
            phaseId: postMortemPhaseType.id,
            name: postMortemPhaseType.name,
            description: postMortemPhaseType.description,
            predecessor: predecessorPhase.phaseId ?? predecessorPhase.id,
            duration: Math.max(Math.round((end.getTime() - now.getTime()) / 1000), 1),
            scheduledStartDate: now,
            scheduledEndDate: end,
            actualStartDate: openImmediately ? now : null,
            isOpen: !!openImmediately,
            createdBy: 'Autopilot',
            updatedBy: 'Autopilot',
          },
        });

        // Maintain currentPhaseNames only if opening immediately
        if (openImmediately) {
          updatedPhaseNames.add(postMortemPhaseType.name);
          await tx.challenge.update({
            where: { id: challengeId },
            data: { currentPhaseNames: Array.from(updatedPhaseNames) },
          });
        }

        return { createdPhaseId: created.id };
      });

      const refreshed = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      const phaseRecord = refreshed?.phases.find(
        (phase) => phase.id === createdPhaseId,
      );

      if (!phaseRecord) {
        throw new Error(
          `Created post-mortem phase ${createdPhaseId} not found after insertion for challenge ${challengeId}.`,
        );
      }

      const mapped = this.mapPhase(phaseRecord);

      void this.dbLogger.logAction('challenge.createPostMortemPhase', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          postMortemPhaseId: mapped.id,
          durationHours,
          preserveFuturePhases: true,
          openImmediately,
          predecessorPhaseId,
          closedApprovalPhaseCount,
        },
      });

      return mapped;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.createPostMortemPhase', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          predecessorPhaseId,
          durationHours,
          preserveFuturePhases: true,
          openImmediately,
          error: err.message,
        },
      });
      throw err;
    }
  }

  private async createContinuationPhase(
    logAction: string,
    challengeId: string,
    predecessorPhaseId: string,
    phaseTypeId: string,
    phaseName: string,
    phaseDescription: string | null,
    durationSeconds: number,
  ): Promise<IPhase> {
    const now = new Date();
    const scheduledEnd = new Date(now.getTime() + durationSeconds * 1000);

    try {
      const { newPhaseId } = await this.prisma.$transaction(async (tx) => {
        const challenge = await tx.challenge.findUnique({
          ...challengeWithRelationsArgs,
          where: { id: challengeId },
        });

        if (!challenge) {
          throw new NotFoundException(
            `Challenge with ID ${challengeId} not found when creating follow-up phase ${phaseName}.`,
          );
        }

        const predecessorPhase = challenge.phases.find(
          (phase) => phase.id === predecessorPhaseId,
        );

        if (!predecessorPhase) {
          throw new NotFoundException(
            `Predecessor phase ${predecessorPhaseId} not found for challenge ${challengeId} when creating follow-up phase ${phaseName}.`,
          );
        }

        const created = await tx.challengePhase.create({
          data: {
            challengeId,
            phaseId: phaseTypeId,
            name: phaseName,
            description: phaseDescription,
            predecessor: predecessorPhase.id,
            duration: Math.max(durationSeconds, 1),
            scheduledStartDate: now,
            scheduledEndDate: scheduledEnd,
            actualStartDate: now,
            actualEndDate: null,
            isOpen: true,
            createdBy: 'Autopilot',
            updatedBy: 'Autopilot',
          },
        });

        const phaseNames = new Set(challenge.currentPhaseNames ?? []);
        phaseNames.add(phaseName);

        await tx.challenge.update({
          where: { id: challengeId },
          data: {
            currentPhaseNames: Array.from(phaseNames),
          },
        });

        return { newPhaseId: created.id };
      });

      const refreshed = await this.prisma.challenge.findUnique({
        ...challengeWithRelationsArgs,
        where: { id: challengeId },
      });

      const phaseRecord = refreshed?.phases.find(
        (phase) => phase.id === newPhaseId,
      );

      if (!phaseRecord) {
        throw new Error(
          `Created follow-up phase ${newPhaseId} not found after insertion for challenge ${challengeId}.`,
        );
      }

      const mapped = this.mapPhase(phaseRecord);

      void this.dbLogger.logAction(logAction, {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: {
          predecessorPhaseId,
          phaseId: mapped.id,
          phaseTypeId,
          duration: mapped.duration,
        },
      });

      return mapped;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction(logAction, {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          predecessorPhaseId,
          phaseTypeId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async createIterativeReviewPhase(
    challengeId: string,
    predecessorPhaseId: string,
    phaseTypeId: string,
    phaseName: string,
    phaseDescription: string | null,
    durationSeconds: number,
  ): Promise<IPhase> {
    return this.createContinuationPhase(
      'challenge.createIterativeReviewPhase',
      challengeId,
      predecessorPhaseId,
      phaseTypeId,
      phaseName,
      phaseDescription,
      durationSeconds,
    );
  }

  async createApprovalPhase(
    challengeId: string,
    predecessorPhaseId: string,
    phaseTypeId: string,
    phaseName: string,
    phaseDescription: string | null,
    durationSeconds: number,
  ): Promise<IPhase> {
    return this.createContinuationPhase(
      'challenge.createApprovalPhase',
      challengeId,
      predecessorPhaseId,
      phaseTypeId,
      phaseName,
      phaseDescription,
      durationSeconds,
    );
  }

  async completeChallenge(
    challengeId: string,
    winners: IChallengeWinner[],
  ): Promise<void> {
    try {
      const endDate = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.challenge.update({
          where: { id: challengeId },
          data: {
            status: ChallengeStatusEnum.COMPLETED,
            endDate,
          },
        });

        await tx.challengeWinner.deleteMany({
          where: { challengeId, type: PrizeSetTypeEnum.PLACEMENT },
        });

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
        details: { winnersCount: winners.length, endDate: endDate.toISOString() },
      });
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.completeChallenge', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          winnersCount: winners.length,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async setCheckpointWinners(
    challengeId: string,
    winners: IChallengeWinner[],
  ): Promise<void> {
    this.checkpointWinnerQueryLogIds.add(challengeId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.challengeWinner.deleteMany({
          where: { challengeId, type: PrizeSetTypeEnum.CHECKPOINT },
        });

        if (winners.length) {
          await tx.challengeWinner.createMany({
            data: winners.map((winner) => ({
              challengeId,
              userId: winner.userId,
              handle: winner.handle,
              placement: winner.placement,
              type: PrizeSetTypeEnum.CHECKPOINT,
              createdBy: 'Autopilot',
              updatedBy: 'Autopilot',
            })),
          });
        }
      });

      void this.dbLogger.logAction('challenge.setCheckpointWinners', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: { winnersCount: winners.length },
      });
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.setCheckpointWinners', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: {
          winnersCount: winners.length,
          error: err.message,
        },
      });
      throw err;
    } finally {
      this.checkpointWinnerQueryLogIds.delete(challengeId);
    }
  }

  private attachCheckpointWinnerQueryLogger(): void {
    if (this.checkpointWinnerQueryLoggerAttached) {
      return;
    }

    if (typeof this.prisma.$on !== 'function') {
      return;
    }

    this.checkpointWinnerQueryLoggerAttached = true;

    this.prisma.$on('query', (event) => {
      if (this.checkpointWinnerQueryLogIds.size === 0) {
        return;
      }

      const query = event.query ?? '';
      const normalizedQuery = query.trimStart().toUpperCase();
      if (!normalizedQuery.startsWith('INSERT')) {
        return;
      }

      if (!query.includes('"ChallengeWinner"')) {
        return;
      }

      const params = event.params ?? '';
      if (!params.includes('CHECKPOINT')) {
        return;
      }

      let matchedChallengeId: string | undefined;
      for (const challengeId of this.checkpointWinnerQueryLogIds) {
        if (params.includes(challengeId)) {
          matchedChallengeId = challengeId;
          break;
        }
      }

      if (!matchedChallengeId) {
        return;
      }

      void this.dbLogger.logAction(
        'challenge.setCheckpointWinners.insertQuery',
        {
          challengeId: matchedChallengeId,
          status: 'INFO',
          source: ChallengeApiService.name,
          details: {
            query,
            params,
            durationMs: event.duration,
          },
        },
      );
    });
  }

  async cancelChallenge(
    challengeId: string,
    status: ChallengeStatusEnum,
  ): Promise<void> {
    try {
      const endDate = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.challenge.update({
          where: { id: challengeId },
          data: {
            status,
            endDate,
          },
        });

        await tx.challengeWinner.deleteMany({ where: { challengeId } });
      });

      void this.dbLogger.logAction('challenge.cancelChallenge', {
        challengeId,
        status: 'SUCCESS',
        source: ChallengeApiService.name,
        details: { status, endDate: endDate.toISOString() },
      });
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('challenge.cancelChallenge', {
        challengeId,
        status: 'ERROR',
        source: ChallengeApiService.name,
        details: { status, error: err.message },
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
