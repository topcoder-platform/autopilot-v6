import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ChallengePrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(ChallengePrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('challenge.dbUrl');

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
        'CHALLENGE_DB_URL is not configured. Prisma client will rely on the default environment resolution.',
        ChallengePrismaService.name,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Challenge DB.');
  }
}
