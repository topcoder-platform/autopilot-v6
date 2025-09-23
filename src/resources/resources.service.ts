import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResourcesPrismaService } from './resources-prisma.service';

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

  constructor(private readonly prisma: ResourcesPrismaService) {}

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

    const reviewers =
      await this.prisma.$queryRaw<ReviewerResourceRecord[]>(query);
    return reviewers;
  }
}
