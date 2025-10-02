import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class MembersPrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(MembersPrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('members.dbUrl');

    super(
      databaseUrl
        ? {
            datasources: {
              db: {
                url: databaseUrl,
              },
            },
          }
        : undefined,
    );

    if (!databaseUrl) {
      Logger.warn(
        'MEMBERS_DB_URL is not configured. Prisma client will rely on the default environment resolution.',
        MembersPrismaService.name,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Members DB.');
  }
}
