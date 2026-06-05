import { Module } from '@nestjs/common';
import { ChallengeApiService } from './challenge-api.service';
import { ChallengePrismaService } from './challenge-prisma.service';
import { ReviewModule } from '../review/review.module';

@Module({
  imports: [ReviewModule],
  providers: [ChallengeApiService, ChallengePrismaService],
  exports: [ChallengeApiService],
})
export class ChallengeModule {}
