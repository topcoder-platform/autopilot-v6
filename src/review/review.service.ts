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
  private static readonly REVIEW_SUMMATION_TABLE = Prisma.sql`"reviewSummation"`;

  constructor(private readonly prisma: ReviewPrismaService) {}

  async getTopFinalReviewScores(
    challengeId: string,
    limit = 3,
  ): Promise<
    Array<{
      memberId: string;
      submissionId: string;
      aggregateScore: number;
    }>
  > {
    if (!challengeId) {
      return [];
    }

    const fetchLimit = Math.max(limit, 1) * 5;
    const limitClause = Prisma.sql`LIMIT ${fetchLimit}`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        memberId: string | null;
        submissionId: string;
        aggregateScore: number | string | null;
      }>
    >(Prisma.sql`
      SELECT
        s."memberId" AS "memberId",
        s."id" AS "submissionId",
        rs."aggregateScore" AS "aggregateScore"
      FROM ${ReviewService.REVIEW_SUMMATION_TABLE} rs
      INNER JOIN ${ReviewService.SUBMISSION_TABLE} s
        ON s."id" = rs."submissionId"
      WHERE s."challengeId" = ${challengeId}
        AND rs."isFinal" = true
        AND rs."aggregateScore" IS NOT NULL
        AND s."memberId" IS NOT NULL
        AND s."type" = 'CONTEST_SUBMISSION'
      ORDER BY rs."aggregateScore" DESC, s."submittedDate" ASC, s."id" ASC
      ${limitClause}
    `);

    if (!rows.length) {
      return [];
    }

    const seenMembers = new Set<string>();
    const winners: Array<{
      memberId: string;
      submissionId: string;
      aggregateScore: number;
    }> = [];

    for (const row of rows) {
      const memberId = row.memberId?.trim();
      if (!memberId || seenMembers.has(memberId)) {
        continue;
      }

      const aggregateScore =
        typeof row.aggregateScore === 'string'
          ? Number(row.aggregateScore)
          : (row.aggregateScore ?? 0);

      if (Number.isNaN(aggregateScore)) {
        continue;
      }

      winners.push({
        memberId,
        submissionId: row.submissionId,
        aggregateScore,
      });
      seenMembers.add(memberId);

      if (winners.length >= limit) {
        break;
      }
    }

    return winners;
  }

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
