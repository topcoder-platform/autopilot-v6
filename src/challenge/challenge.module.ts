import { Module } from '@nestjs/common';
import { ChallengeService } from './challenge.service';
import { ChallengeApiService } from './challenge-api.service';

@Module({
  providers: [ChallengeService, ChallengeApiService],
  exports: [ChallengeService, ChallengeApiService],
})
export class ChallengeModule {}
