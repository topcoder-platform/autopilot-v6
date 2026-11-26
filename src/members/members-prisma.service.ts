import { createPostgresAdapter } from '../prisma-adapter';
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

    super({
      adapter: createPostgresAdapter(databaseUrl ?? process.env.MEMBER_DB_URL),
    });

  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.debug('Disconnected Prisma client for Members DB.');
  }
}
