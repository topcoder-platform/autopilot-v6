import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
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

interface ResourceRoleRecord {
  id: string;
  name: string;
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

  async getPhaseChangeNotificationResources(
    challengeId: string,
  ): Promise<ReviewerResourceRecord[]> {
    if (!challengeId) {
      return [];
    }

    const query = Prisma.sql`
      SELECT
        r."id",
        r."memberId",
        r."memberHandle",
        rr."name" AS "roleName"
      FROM ${ResourcesService.RESOURCE_TABLE} r
      INNER JOIN ${ResourcesService.RESOURCE_ROLE_TABLE} rr ON rr."id" = r."roleId"
      WHERE r."challengeId" = ${challengeId}
        AND r."phaseChangeNotifications" IS TRUE
    `;

    try {
      const recipients =
        await this.prisma.$queryRaw<ReviewerResourceRecord[]>(query);

      void this.dbLogger.logAction(
        'resources.getPhaseChangeNotificationResources',
        {
          challengeId,
          status: 'SUCCESS',
          source: ResourcesService.name,
          details: { recipientCount: recipients.length },
        },
      );

      return recipients;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction(
        'resources.getPhaseChangeNotificationResources',
        {
          challengeId,
          status: 'ERROR',
          source: ResourcesService.name,
          details: { error: err.message },
        },
      );
      throw err;
    }
  }

  async getResourceByMemberHandle(
    challengeId: string,
    memberHandle: string,
  ): Promise<ResourceRecord | null> {
    if (!challengeId || !memberHandle) {
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
      WHERE r."challengeId" = ${challengeId}
        AND LOWER(r."memberHandle") = LOWER(${memberHandle})
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<ResourceRecord[]>(query);

      if (!record) {
        void this.dbLogger.logAction('resources.getResourceByMemberHandle', {
          challengeId,
          status: 'SUCCESS',
          source: ResourcesService.name,
          details: {
            memberHandle,
            found: false,
          },
        });

        return null;
      }

      void this.dbLogger.logAction('resources.getResourceByMemberHandle', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          memberHandle,
          resourceId: record.id,
          roleName: record.roleName,
        },
      });

      return record;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getResourceByMemberHandle', {
        challengeId,
        status: 'ERROR',
        source: ResourcesService.name,
        details: {
          memberHandle,
          error: err.message,
        },
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

  async getResourceRoleIdByName(roleName: string): Promise<string | null> {
    const normalized = roleName?.trim();
    if (!normalized) {
      return null;
    }

    const query = Prisma.sql`
      SELECT "id", "name"
      FROM ${ResourcesService.RESOURCE_ROLE_TABLE}
      WHERE LOWER("name") = LOWER(${normalized})
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<ResourceRoleRecord[]>(query);

      if (!record?.id) {
        void this.dbLogger.logAction('resources.getResourceRoleIdByName', {
          challengeId: null,
          status: 'SUCCESS',
          source: ResourcesService.name,
          details: { roleName: normalized, found: false },
        });
        return null;
      }

      void this.dbLogger.logAction('resources.getResourceRoleIdByName', {
        challengeId: null,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: { roleName: normalized, roleId: record.id },
      });

      return record.id;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('resources.getResourceRoleIdByName', {
        challengeId: null,
        status: 'ERROR',
        source: ResourcesService.name,
        details: { roleName: normalized, error: err.message },
      });
      throw err;
    }
  }

  async ensureResourcesForMembers(
    challengeId: string,
    members: ReviewerResourceRecord[],
    roleName: string,
  ): Promise<ReviewerResourceRecord[]> {
    const normalizedRole = roleName?.trim();
    if (!challengeId || !normalizedRole) {
      return [];
    }

    const uniqueMembers = new Map<string, ReviewerResourceRecord>();
    for (const member of members) {
      const memberId = member.memberId?.trim();
      if (!memberId) {
        continue;
      }
      if (!uniqueMembers.has(memberId)) {
        uniqueMembers.set(memberId, member);
      }
    }

    if (!uniqueMembers.size) {
      return this.getResourcesByRoleNames(challengeId, [normalizedRole]);
    }

    const roleId = await this.getResourceRoleIdByName(normalizedRole);
    if (!roleId) {
      this.dbLogger.logAction('resources.ensureResourcesForMembers', {
        challengeId,
        status: 'SUCCESS',
        source: ResourcesService.name,
        details: {
          roleName: normalizedRole,
          sourceCount: members.length,
          createdCount: 0,
          reason: 'ROLE_NOT_FOUND',
        },
      });
      return [];
    }

    const memberIds = Array.from(uniqueMembers.keys());
    const memberIdList = Prisma.join(memberIds.map((id) => Prisma.sql`${id}`));

    let existing: ReviewerResourceRecord[] = [];
    if (memberIds.length) {
      existing = await this.prisma.$queryRaw<ReviewerResourceRecord[]>(
        Prisma.sql`
          SELECT r."id", r."memberId", r."memberHandle", rr."name" AS "roleName"
          FROM ${ResourcesService.RESOURCE_TABLE} r
          INNER JOIN ${ResourcesService.RESOURCE_ROLE_TABLE} rr
            ON rr."id" = r."roleId"
          WHERE r."challengeId" = ${challengeId}
            AND rr."name" = ${normalizedRole}
            AND r."memberId" IN (${memberIdList})
        `,
      );
    }

    const existingMemberIds = new Set(
      existing.map((record) => record.memberId?.trim()).filter(Boolean),
    );

    const toCreate = memberIds.filter(
      (memberId) => !existingMemberIds.has(memberId),
    );

    const created: ReviewerResourceRecord[] = [];
    if (toCreate.length) {
      await this.prisma.$transaction(
        async (tx) => {
          for (const memberId of toCreate) {
            const source = uniqueMembers.get(memberId);
            if (!source) {
              continue;
            }

            const resourceId = randomUUID();
            const memberHandle =
              source.memberHandle?.trim() ||
              source.memberId?.trim() ||
              memberId;

            await tx.$executeRaw(
              Prisma.sql`
                INSERT INTO ${ResourcesService.RESOURCE_TABLE} (
                  "id",
                  "challengeId",
                  "memberId",
                  "memberHandle",
                  "roleId",
                  "phaseChangeNotifications",
                  "createdBy",
                  "updatedBy"
                )
                VALUES (
                  ${resourceId},
                  ${challengeId},
                  ${memberId},
                  ${memberHandle},
                  ${roleId},
                  TRUE,
                  'Autopilot',
                  'Autopilot'
                )
              `,
            );

            created.push({
              id: resourceId,
              memberId,
              memberHandle,
              roleName: normalizedRole,
            });
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );
    }

    const finalRecords = await this.getResourcesByRoleNames(challengeId, [
      normalizedRole,
    ]);

    void this.dbLogger.logAction('resources.ensureResourcesForMembers', {
      challengeId,
      status: 'SUCCESS',
      source: ResourcesService.name,
      details: {
        roleName: normalizedRole,
        sourceCount: members.length,
        uniqueSourceCount: uniqueMembers.size,
        createdCount: created.length,
        finalCount: finalRecords.length,
      },
    });

    return finalRecords;
  }
}
