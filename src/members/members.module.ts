import { Module } from '@nestjs/common';
import { MembersPrismaService } from './members-prisma.service';
import { MembersService } from './members.service';

@Module({
  providers: [MembersPrismaService, MembersService],
  exports: [MembersService],
})
export class MembersModule {}
