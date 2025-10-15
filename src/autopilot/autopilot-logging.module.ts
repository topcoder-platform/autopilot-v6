import { Global, Module } from '@nestjs/common';
import { AutopilotDbLoggerService } from './services/autopilot-db-logger.service';
import { AutopilotPrismaService } from './services/autopilot-prisma.service';
import { AutopilotActionsCleanupService } from './services/autopilot-actions-cleanup.service';

@Global()
@Module({
  providers: [
    AutopilotPrismaService,
    AutopilotDbLoggerService,
    AutopilotActionsCleanupService,
  ],
  exports: [AutopilotDbLoggerService],
})
export class AutopilotLoggingModule {}
