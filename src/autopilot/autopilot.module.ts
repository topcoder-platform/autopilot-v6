import { Module, forwardRef } from '@nestjs/common';
import { AutopilotService } from './services/autopilot.service';
import { KafkaModule } from '../kafka/kafka.module';
import { SchedulerService } from './services/scheduler.service';

@Module({
  imports: [forwardRef(() => KafkaModule)],
  providers: [AutopilotService, SchedulerService],
  exports: [AutopilotService],
})
export class AutopilotModule {}
