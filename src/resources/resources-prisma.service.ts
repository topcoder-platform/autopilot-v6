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
        'RESOURCES_DB_URL is not configured. Prisma client will rely on the default environment resolution.',
        ResourcesPrismaService.name,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Resources DB.');
  }
}
