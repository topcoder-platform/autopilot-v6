import { Global, Module } from '@nestjs/common';
import { AutopilotDbLoggerService } from './services/autopilot-db-logger.service';
import { AutopilotPrismaService } from './services/autopilot-prisma.service';

@Global()
@Module({
  providers: [AutopilotPrismaService, AutopilotDbLoggerService],
  exports: [AutopilotDbLoggerService],
})
export class AutopilotLoggingModule {}
