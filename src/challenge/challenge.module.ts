import { Module } from '@nestjs/common';
import { ChallengeApiService } from './challenge-api.service';
import { ChallengePrismaService } from './challenge-prisma.service';

@Module({
  providers: [ChallengeApiService, ChallengePrismaService],
  exports: [ChallengeApiService],
})
export class ChallengeModule {}
