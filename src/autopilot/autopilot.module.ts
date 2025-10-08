import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
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
import { PhaseScheduleManager } from './services/phase-schedule-manager.service';
import { ResourceEventHandler } from './services/resource-event-handler.service';
import { First2FinishService } from './services/first2finish.service';
import { MembersModule } from '../members/members.module';
import { Auth0Module } from '../auth/auth0.module';
import { PhaseChangeNotificationService } from './services/phase-change-notification.service';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [
    forwardRef(() => KafkaModule),
    // Corrected: Removed .forRoot() as it's already called in the root AppModule.
    // This makes the providers from ScheduleModule available here without re-registering them.
    ScheduleModule,
    HttpModule,
    ChallengeModule,
    ReviewModule,
    ResourcesModule,
    MembersModule,
    Auth0Module,
    FinanceModule,
  ],
  providers: [
    AutopilotService,
    SchedulerService,
    PhaseScheduleManager,
    ResourceEventHandler,
    First2FinishService,
    PhaseReviewService,
    ReviewAssignmentService,
    ChallengeCompletionService,
    PhaseChangeNotificationService,
  ],
  exports: [AutopilotService, SchedulerService],
})
export class AutopilotModule {}
