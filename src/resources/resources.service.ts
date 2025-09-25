import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResourcesPrismaService } from './resources-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

export interface ReviewerResourceRecord {
  id: string;
  memberId: string;
  memberHandle: string;
  roleName: string;
}

@Injectable()
export class ResourcesService {
  private static readonly RESOURCE_TABLE = Prisma.sql`"Resource"`;
  private static readonly RESOURCE_ROLE_TABLE = Prisma.sql`"ResourceRole"`;

  constructor(
    private readonly prisma: ResourcesPrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  async getMemberHandleMap(
    challengeId: string,
    memberIds: string[],
  ): Promise<Map<string, string>> {
    if (!challengeId || !memberIds.length) {
      return new Map();
    }

    const uniqueIds = Array.from(
      new Set(memberIds.map((id) => id?.trim()).filter(Boolean)),
    );

    if (!uniqueIds.length) {
      return new Map();
    }

    const idList = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}`));

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ memberId: string; memberHandle: string | null }>
      >(Prisma.sql`
        SELECT r."memberId", r."memberHandle"
        FROM ${ResourcesService.RESOURCE_TABLE} r
        WHERE r."challengeId" = ${challengeId}
          AND r."memberId" IN (${idList})
      `);

      const handleMap = new Map(
        rows
          .filter((row) => Boolean(row.memberId))
          .map((row) => [
            String(row.memberId),
            row.memberHandle?.trim() || String(row.memberId),
          ]),
      );

      void this.dbLogger.logAction('resources.getMemberHandleMap', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: { inputCount: uniqueIds.length, matchedCount: handleMap.size },
      });

      return handleMap;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getMemberHandleMap', {
        challengeId,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { inputCount: uniqueIds.length, error: err.message },
      });
      throw err;
    }
  }

  async getReviewerResources(
    challengeId: string,
    roleNames: string[],
  ): Promise<ReviewerResourceRecord[]> {
    if (!roleNames.length) {
      return [];
    }

    const roleList = Prisma.join(roleNames);

    const query = Prisma.sql`
      SELECT r."id", r."memberId", r."memberHandle", rr."name" AS "roleName"
      FROM ${ResourcesService.RESOURCE_TABLE} r
      INNER JOIN ${ResourcesService.RESOURCE_ROLE_TABLE} rr ON rr."id" = r."roleId"
      WHERE r."challengeId" = ${challengeId}
        AND rr."name" IN (${roleList})
    `;

    try {
      const reviewers =
        await this.prisma.$queryRaw<ReviewerResourceRecord[]>(query);

      void this.dbLogger.logAction('resources.getReviewerResources', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          roleCount: roleNames.length,
          reviewerCount: reviewers.length,
        },
      });

      return reviewers;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getReviewerResources', {
        challengeId,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { roleCount: roleNames.length, error: err.message },
      });
      throw err;
    }
  }
}
