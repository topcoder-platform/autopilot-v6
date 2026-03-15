import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { Auth0Module } from '../auth/auth0.module';
import { ReviewModule } from '../review/review.module';
import { MarathonMatchApiService } from './marathon-match-api.service';
import { MarathonMatchReviewService } from './marathon-match-review.service';

@Module({
  imports: [HttpModule, ReviewModule, Auth0Module],
  providers: [MarathonMatchApiService, MarathonMatchReviewService],
  exports: [MarathonMatchApiService, MarathonMatchReviewService],
})
export class MarathonMatchModule {}
