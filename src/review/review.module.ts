import { Module } from '@nestjs/common';
import { ReviewPrismaService } from './review-prisma.service';
import { ReviewService } from './review.service';

@Module({
  providers: [ReviewPrismaService, ReviewService],
  exports: [ReviewService],
})
export class ReviewModule {}
