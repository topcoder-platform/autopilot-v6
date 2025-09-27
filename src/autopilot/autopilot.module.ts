import { Module, forwardRef } from '@nestjs/common';
import { AutopilotService } from './services/autopilot.service';
import { KafkaModule } from '../kafka/kafka.module';
import { SchedulerService } from './services/scheduler.service';
import { ScheduleModule } from '@nestjs/schedule';
import { ChallengeModule } from '../challenge/challenge.module';
import { ReviewModule } from '../review/review.module';
import { ResourcesModule } from '../resources/resources.module';
import { PhaseReviewService } from './services/phase-review.service';
import { ReviewAssignmentService } from './services/review-assignment.service';
import { ChallengeCompletionService } from './services/challenge-completion.service';

@Module({
  imports: [
    forwardRef(() => KafkaModule),
    // Corrected: Removed .forRoot() as it's already called in the root AppModule.
    // This makes the providers from ScheduleModule available here without re-registering them.
    ScheduleModule,
    ChallengeModule,
    ReviewModule,
    ResourcesModule,
  ],
  providers: [
    AutopilotService,
    SchedulerService,
    PhaseReviewService,
    ReviewAssignmentService,
    ChallengeCompletionService,
  ],
  exports: [AutopilotService, SchedulerService],
})
export class AutopilotModule {}
