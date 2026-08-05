import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MembersPrismaService } from './members-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

export interface MemberEmailLookupInput {
  memberIds?: string[];
  handles?: string[];
}

export interface MemberEmailProfile {
  email: string;
  city: string | null;
  homeCountryCode: string | null;
  competitionCountryCode: string | null;
}

export interface MemberEmailLookupResult {
  idToMember: Map<string, MemberEmailProfile>;
  handleToMember: Map<string, MemberEmailProfile>;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: MembersPrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  /**
   * Resolves member email addresses and the city from each member's first saved
   * profile address for individualized phase-change notifications.
   *
   * @param params Member IDs and handles that identify notification recipients.
   * @returns Member details keyed by normalized user ID and handle.
   * @throws The members database error when recipient details cannot be loaded.
   */
  async getMemberEmails(
    params: MemberEmailLookupInput,
  ): Promise<MemberEmailLookupResult> {
    const idCandidates = params.memberIds ?? [];
    const handleCandidates = params.handles ?? [];

    const memberIds = Array.from(
      new Set(
        idCandidates
          .map((value) => value?.trim())
          .filter(
            (value): value is string => Boolean(value) && /^\d+$/.test(value),
          ),
      ),
    );

    const handles = Array.from(
      new Set(
        handleCandidates
          .map((value) => value?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const idToMember = new Map<string, MemberEmailProfile>();
    const handleToMember = new Map<string, MemberEmailProfile>();

    if (!memberIds.length && !handles.length) {
      void this.dbLogger.logAction('members.getMemberEmails', {
        status: 'INFO',
        source: MembersService.name,
        details: {
          inputIds: idCandidates.length,
          inputHandles: handleCandidates.length,
          resolvedIds: 0,
          resolvedHandles: 0,
          note: 'No member identifiers provided after normalization.',
        },
      });

      return { idToMember, handleToMember };
    }

    try {
      if (memberIds.length) {
        const idList = Prisma.join(
          memberIds.map((id) => Prisma.sql`${BigInt(id)}`),
        );

        const rows = await this.prisma.$queryRaw<
          Array<{
            userId: bigint;
            email: string | null;
            city: string | null;
            homeCountryCode: string | null;
            competitionCountryCode: string | null;
          }>
        >(
          Prisma.sql`
            SELECT
              m."userId",
              m."email",
              m."homeCountryCode",
              m."competitionCountryCode",
              (
                SELECT a."city"
                FROM "memberAddress" a
                WHERE a."userId" = m."userId"
                ORDER BY a."id" ASC
                LIMIT 1
              ) AS "city"
            FROM "member" m
            WHERE m."userId" IN (${idList})
          `,
        );

        for (const row of rows) {
          if (!row.userId || !row.email) {
            continue;
          }
          idToMember.set(row.userId.toString(), {
            email: row.email.trim(),
            city: row.city?.trim() || null,
            homeCountryCode: row.homeCountryCode?.trim() || null,
            competitionCountryCode: row.competitionCountryCode?.trim() || null,
          });
        }
      }

      if (handles.length) {
        const handleList = Prisma.join(
          handles.map((handle) => Prisma.sql`${handle}`),
        );

        const rows = await this.prisma.$queryRaw<
          Array<{
            handleLower: string;
            email: string | null;
            city: string | null;
            homeCountryCode: string | null;
            competitionCountryCode: string | null;
          }>
        >(
          Prisma.sql`
            SELECT
              m."handleLower",
              m."email",
              m."homeCountryCode",
              m."competitionCountryCode",
              (
                SELECT a."city"
                FROM "memberAddress" a
                WHERE a."userId" = m."userId"
                ORDER BY a."id" ASC
                LIMIT 1
              ) AS "city"
            FROM "member" m
            WHERE m."handleLower" IN (${handleList})
          `,
        );

        for (const row of rows) {
          if (!row.handleLower || !row.email) {
            continue;
          }
          handleToMember.set(row.handleLower.trim(), {
            email: row.email.trim(),
            city: row.city?.trim() || null,
            homeCountryCode: row.homeCountryCode?.trim() || null,
            competitionCountryCode: row.competitionCountryCode?.trim() || null,
          });
        }
      }

      void this.dbLogger.logAction('members.getMemberEmails', {
        status: 'SUCCESS',
        source: MembersService.name,
        details: {
          inputIds: idCandidates.length,
          inputHandles: handleCandidates.length,
          resolvedIds: memberIds.length,
          resolvedHandles: handles.length,
          matchedIds: idToMember.size,
          matchedHandles: handleToMember.size,
        },
      });

      return { idToMember, handleToMember };
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('members.getMemberEmails', {
        status: 'ERROR',
        source: MembersService.name,
        details: {
          inputIds: idCandidates.length,
          inputHandles: handleCandidates.length,
          error: err.message,
        },
      });
      throw err;
    }
  }
}
