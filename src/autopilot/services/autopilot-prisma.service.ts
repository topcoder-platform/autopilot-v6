import { createPostgresAdapter } from '../../prisma-adapter';
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

    super({
      adapter: createPostgresAdapter(databaseUrl ?? process.env.AUTOPILOT_DB_URL),
    });

  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Autopilot DB.');
  }
}
