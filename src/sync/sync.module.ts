import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { AutopilotModule } from '../autopilot/autopilot.module';
import { ChallengeModule } from '../challenge/challenge.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    // Import ScheduleModule without .forRoot() as it's already done in the root AppModule
    ScheduleModule,
    AutopilotModule,
    ChallengeModule,
    // Import ConfigModule to make ConfigService available for injection
    ConfigModule,
  ],
  providers: [SyncService],
})
export class SyncModule {}
