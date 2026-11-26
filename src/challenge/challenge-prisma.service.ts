import { createPostgresAdapter } from '../prisma-adapter';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class ChallengePrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(ChallengePrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('challenge.dbUrl');
    const dbDebugEnabled =
      configService.get<boolean>('autopilot.dbDebug') ?? false;
    const logConfig: Prisma.LogDefinition[] = [
      { emit: 'event', level: 'query' },
    ];

    super({
      adapter: createPostgresAdapter(databaseUrl ?? process.env.CHALLENGE_DB_URL),
      ...(dbDebugEnabled ? { log: logConfig } : {}),
    });

  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Challenge DB.');
  }
}
