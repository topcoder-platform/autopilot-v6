import { Module, forwardRef } from '@nestjs/common';
import { AutopilotService } from './services/autopilot.service';
import { KafkaModule } from '../kafka/kafka.module';
import { SchedulerService } from './services/scheduler.service';
import { ScheduleModule } from '@nestjs/schedule';
import { ChallengeModule } from '../challenge/challenge.module';

@Module({
  imports: [
    forwardRef(() => KafkaModule),
    ScheduleModule.forRoot(),
    ChallengeModule,
  ],
  providers: [AutopilotService, SchedulerService],
  exports: [AutopilotService],
})
export class AutopilotModule {}
