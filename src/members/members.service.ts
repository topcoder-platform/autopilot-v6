import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MembersPrismaService } from './members-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

export interface MemberEmailLookupInput {
  memberIds?: string[];
  handles?: string[];
}

export interface MemberEmailLookupResult {
  idToEmail: Map<string, string>;
  handleToEmail: Map<string, string>;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: MembersPrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  async getMemberEmails(
    params: MemberEmailLookupInput,
  ): Promise<MemberEmailLookupResult> {
    const idCandidates = params.memberIds ?? [];
    const handleCandidates = params.handles ?? [];

    const memberIds = Array.from(
      new Set(
        idCandidates
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value) && /^\d+$/.test(value)),
      ),
    );

    const handles = Array.from(
      new Set(
        handleCandidates
          .map((value) => value?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const idToEmail = new Map<string, string>();
    const handleToEmail = new Map<string, string>();

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

      return { idToEmail, handleToEmail };
    }

    try {
      if (memberIds.length) {
        const idList = Prisma.join(
          memberIds.map((id) => Prisma.sql`${BigInt(id)}`),
        );

        const rows = await this.prisma.$queryRaw<Array<{ userId: bigint; email: string | null }>>(
          Prisma.sql`
            SELECT "userId", "email"
            FROM "member"
            WHERE "userId" IN (${idList})
          `,
        );

        for (const row of rows) {
          if (!row.userId || !row.email) {
            continue;
          }
          idToEmail.set(row.userId.toString(), row.email.trim());
        }
      }

      if (handles.length) {
        const handleList = Prisma.join(
          handles.map((handle) => Prisma.sql`${handle}`),
        );

        const rows = await this.prisma.$queryRaw<Array<{ handleLower: string; email: string | null }>>(
          Prisma.sql`
            SELECT "handleLower", "email"
            FROM "member"
            WHERE "handleLower" IN (${handleList})
          `,
        );

        for (const row of rows) {
          if (!row.handleLower || !row.email) {
            continue;
          }
          handleToEmail.set(row.handleLower.trim(), row.email.trim());
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
          matchedIds: idToEmail.size,
          matchedHandles: handleToEmail.size,
        },
      });

      return { idToEmail, handleToEmail };
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
