import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class AutopilotPrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(AutopilotPrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('autopilot.dbUrl');

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
        'AUTOPILOT_DB_URL is not configured. Prisma client will rely on the default environment resolution.',
        AutopilotPrismaService.name,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Autopilot DB.');
  }
}
