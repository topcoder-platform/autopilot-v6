import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { KafkaModule } from './kafka/kafka.module';
import { AutopilotModule } from './autopilot/autopilot.module';
import { HealthModule } from './health/health.module';
import { ScheduleModule } from '@nestjs/schedule';
import { RecoveryModule } from './recovery/recovery.module';
import { SyncModule } from './sync/sync.module';
import { AutopilotLoggingModule } from './autopilot/autopilot-logging.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AppConfigModule,
    AutopilotLoggingModule,
    KafkaModule,
    AutopilotModule,
    HealthModule,
    RecoveryModule,
    SyncModule,
  ],
})
export class AppModule {}
