import { Module } from '@nestjs/common';
import { ResourcesPrismaService } from './resources-prisma.service';
import { ResourcesService } from './resources.service';

@Module({
  providers: [ResourcesPrismaService, ResourcesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
