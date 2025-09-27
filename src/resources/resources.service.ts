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

interface CountRecord {
  count: number | string;
}

export interface ResourceRecord extends ReviewerResourceRecord {
  challengeId: string;
  roleId: string;
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

  async getResourcesByRoleNames(
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
      const records =
        await this.prisma.$queryRaw<ReviewerResourceRecord[]>(query);

      void this.dbLogger.logAction('resources.getResourcesByRoleNames', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          roleCount: roleNames.length,
          resourceCount: records.length,
        },
      });

      return records;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getResourcesByRoleNames', {
        challengeId,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { roleCount: roleNames.length, error: err.message },
      });
      throw err;
    }
  }

  async hasSubmitterResource(
    challengeId: string,
    roleNames: string[],
  ): Promise<boolean> {
    if (!roleNames.length) {
      return false;
    }

    const roleList = Prisma.join(roleNames);

    const query = Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM ${ResourcesService.RESOURCE_TABLE} r
      INNER JOIN ${ResourcesService.RESOURCE_ROLE_TABLE} rr ON rr."id" = r."roleId"
      WHERE r."challengeId" = ${challengeId}
        AND rr."name" IN (${roleList})
    `;

    try {
      const [record] = await this.prisma.$queryRaw<CountRecord[]>(query);
      const count = Number(record?.count ?? 0);

      void this.dbLogger.logAction('resources.hasSubmitterResource', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          roleCount: roleNames.length,
          submitterCount: count,
        },
      });

      return count > 0;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.hasSubmitterResource', {
        challengeId,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { roleCount: roleNames.length, error: err.message },
      });
      throw err;
    }
  }

  async getResourceById(id: string): Promise<ResourceRecord | null> {
    if (!id) {
      return null;
    }

    const query = Prisma.sql`
      SELECT
        r."id",
        r."challengeId",
        r."memberId",
        r."memberHandle",
        r."roleId",
        rr."name" AS "roleName"
      FROM ${ResourcesService.RESOURCE_TABLE} r
      INNER JOIN ${ResourcesService.RESOURCE_ROLE_TABLE} rr
        ON rr."id" = r."roleId"
      WHERE r."id" = ${id}
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<ResourceRecord[]>(query);

      if (!record) {
        void this.dbLogger.logAction('resources.getResourceById', {
          challengeId: null,
          status: 'SUCCESS',
          source: ResourcesService.name,
          details: { resourceId: id, found: false },
        });
        return null;
      }

      void this.dbLogger.logAction('resources.getResourceById', {
        challengeId: record.challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: { resourceId: id, roleName: record.roleName },
      });

      return record;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getResourceById', {
        challengeId: null,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { resourceId: id, error: err.message },
      });
      throw err;
    }
  }

  async getRoleNameById(roleId: string): Promise<string | null> {
    if (!roleId) {
      return null;
    }

    const query = Prisma.sql`
      SELECT "name"
      FROM ${ResourcesService.RESOURCE_ROLE_TABLE}
      WHERE "id" = ${roleId}
      LIMIT 1
    `;

    try {
      const [record] =
        await this.prisma.$queryRaw<{ name: string | null }[]>(query);

      const roleName = record?.name ?? null;

      void this.dbLogger.logAction('resources.getRoleNameById', {
        challengeId: null,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          roleId,
          roleName,
        },
      });

      return roleName;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getRoleNameById', {
        challengeId: null,
        status: 'ERROR',
        source: ResourcesService.name,
        details: {
          roleId,
          error: err.message,
        },
      });
      throw err;
    }
  }
}
