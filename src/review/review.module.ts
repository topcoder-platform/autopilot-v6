import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { Auth0Module } from '../auth/auth0.module';
import { AutopilotLoggingModule } from '../autopilot/autopilot-logging.module';
import { ReviewPrismaService } from './review-prisma.service';
import { ReviewService } from './review.service';
import { ReviewApiService } from './review-api.service';

@Module({
  imports: [HttpModule, Auth0Module, AutopilotLoggingModule],
  providers: [ReviewPrismaService, ReviewService, ReviewApiService],
  exports: [ReviewService, ReviewApiService],
})
export class ReviewModule {}
