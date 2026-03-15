import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { Auth0Module } from '../auth/auth0.module';
import { AutopilotLoggingModule } from '../autopilot/autopilot-logging.module';
import { MemberApiService } from './member-api.service';

/**
 * Provides the outbound member-api client used by challenge completion flows.
 */
@Module({
  imports: [HttpModule, Auth0Module, AutopilotLoggingModule],
  providers: [MemberApiService],
  exports: [MemberApiService],
})
export class MemberApiModule {}
