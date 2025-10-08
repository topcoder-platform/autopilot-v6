import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FinanceApiService } from './finance-api.service';
import { Auth0Module } from '../auth/auth0.module';
import { AutopilotLoggingModule } from '../autopilot/autopilot-logging.module';

@Module({
  imports: [HttpModule, Auth0Module, AutopilotLoggingModule],
  providers: [FinanceApiService],
  exports: [FinanceApiService],
})
export class FinanceModule {}

