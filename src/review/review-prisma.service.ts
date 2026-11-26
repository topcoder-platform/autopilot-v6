import { createPostgresAdapter } from '../prisma-adapter';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ReviewPrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  private readonly logger = new Logger(ReviewPrismaService.name);

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('review.dbUrl');

    super({
      adapter: createPostgresAdapter(databaseUrl ?? process.env.REVIEW_DB_URL),
    });

  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Review DB.');
  }
}
