import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { ChallengeModule } from '../challenge/challenge.module';
import { AutopilotModule } from '../autopilot/autopilot.module';

@Module({
  // Ensure AutopilotModule is imported so its providers (like SchedulerService) are available
  imports: [ChallengeModule, AutopilotModule],
  providers: [RecoveryService],
  exports: [RecoveryService],
})
export class RecoveryModule {}
