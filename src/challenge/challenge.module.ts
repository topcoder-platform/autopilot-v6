import { Module } from '@nestjs/common';
import { ChallengeApiService } from './challenge-api.service';
import { HttpModule } from '@nestjs/axios';
import { Auth0Module } from '../auth/auth0.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000, // Default timeout for HTTP requests
      maxRedirects: 5,
    }),
    Auth0Module,
  ],
  providers: [ChallengeApiService],
  exports: [ChallengeApiService],
})
export class ChallengeModule {}
