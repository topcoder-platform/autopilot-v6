import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewPrismaService } from './review-prisma.service';

interface SubmissionRecord {
  id: string;
}

interface ReviewRecord {
  submissionId: string | null;
  resourceId: string;
}

@Injectable()
export class ReviewService {
  private static readonly REVIEW_TABLE = Prisma.sql`"review"`;
  private static readonly SUBMISSION_TABLE = Prisma.sql`"submission"`;

  constructor(private readonly prisma: ReviewPrismaService) {}

  async getActiveSubmissionIds(challengeId: string): Promise<string[]> {
    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
    `;

    const submissions = await this.prisma.$queryRaw<SubmissionRecord[]>(query);
    return submissions.map((record) => record.id).filter(Boolean);
  }

  async getExistingReviewPairs(phaseId: string): Promise<Set<string>> {
    const query = Prisma.sql`
      SELECT "submissionId", "resourceId"
      FROM ${ReviewService.REVIEW_TABLE}
      WHERE "phaseId" = ${phaseId}
    `;

    const existing = await this.prisma.$queryRaw<ReviewRecord[]>(query);
    const result = new Set<string>();

    for (const record of existing) {
      if (!record.submissionId) {
        continue;
      }
      result.add(this.composeKey(record.resourceId, record.submissionId));
    }

    return result;
  }

  async createPendingReview(
    submissionId: string,
    resourceId: string,
    phaseId: string,
    scorecardId: string,
  ): Promise<void> {
    const insert = Prisma.sql`
      INSERT INTO ${ReviewService.REVIEW_TABLE} (
        "resourceId",
        "phaseId",
        "submissionId",
        "scorecardId",
        "status",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${resourceId},
        ${phaseId},
        ${submissionId},
        ${scorecardId},
        'PENDING',
        NOW(),
        NOW()
      )
    `;

    await this.prisma.$executeRaw(insert);
  }

  private composeKey(resourceId: string, submissionId: string): string {
    return `${resourceId}:${submissionId}`;
  }
}
