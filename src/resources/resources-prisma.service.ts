import { createPostgresAdapter } from '../prisma-adapter';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ResourcesPrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(ResourcesPrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('resources.dbUrl');

    super({
      adapter: createPostgresAdapter(databaseUrl ?? process.env.RESOURCES_DB_URL),
    });

  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Resources DB.');
  }
}
