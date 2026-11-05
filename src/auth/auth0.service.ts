import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { createM2MClient, type M2MClient } from 'tc-core-library-js';

/** Adapts autopilot configuration to the shared, isolated M2M token cache. */
@Injectable()
export class Auth0Service {
  private client?: M2MClient;

  /** Accepts existing DI dependencies; configuration is validated on first use. No exceptions are raised. */
  constructor(
    httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    void httpService;
  }

  /** Returns the service access token; no arguments, rejects for missing credentials or token endpoint failures. */
  async getAccessToken(): Promise<string> {
    this.client ??= createM2MClient({
      AUTH0_URL: this.configService.get<string>('auth0.url'),
      AUTH0_AUDIENCE: this.configService.get<string>('auth0.audience'),
      AUTH0_PROXY_SERVER_URL: this.configService.get<string>(
        'AUTH0_PROXY_SERVER_URL',
      ),
    });
    return this.client.getMachineToken(
      this.configService.get<string>('auth0.clientId') || '',
      this.configService.get<string>('auth0.clientSecret') || '',
    );
  }

  /** Clears the shared client cache after rejection; takes no arguments, returns void and never throws. */
  clearTokenCache(): void {
    this.client?.clearCache();
  }
}
