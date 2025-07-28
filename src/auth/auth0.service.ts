import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface Auth0TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Auth0TokenCache {
  token: string;
  expiresAt: number;
}

@Injectable()
export class Auth0Service {
  private readonly logger = new Logger(Auth0Service.name);
  private readonly auth0Url: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly audience: string;
  private tokenCache: Auth0TokenCache | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.auth0Url = this.configService.get<string>('auth0.url') || '';
    this.clientId = this.configService.get<string>('auth0.clientId') || '';
    this.clientSecret =
      this.configService.get<string>('auth0.clientSecret') || '';
    this.audience = this.configService.get<string>('auth0.audience') || '';

    if (
      !this.auth0Url ||
      !this.clientId ||
      !this.clientSecret ||
      !this.audience
    ) {
      this.logger.error(
        'Missing required Auth0 configuration. Please check AUTH0_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, and AUTH0_AUDIENCE environment variables.',
      );
    }
  }

  async getAccessToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      this.logger.debug('Using cached Auth0 token');
      return this.tokenCache.token;
    }

    try {
      this.logger.log('Requesting new Auth0 M2M token');

      const tokenUrl = this.auth0Url; // Use the full URL from config
      const body = {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: this.audience,
        grant_type: 'client_credentials',
      };

      const response = await firstValueFrom(
        this.httpService.post<Auth0TokenResponse>(tokenUrl, body, {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }),
      );

      const { access_token, expires_in } = response.data;

      // Cache the token with a buffer (subtract 60 seconds to ensure we refresh before expiry)
      const expiresAt = Date.now() + (expires_in - 60) * 1000;
      this.tokenCache = {
        token: access_token,
        expiresAt,
      };

      this.logger.log('Successfully obtained new Auth0 M2M token');
      return access_token;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to obtain Auth0 M2M token: ${err.message}`,
        err.stack,
      );
      throw new Error('Failed to obtain Auth0 access token');
    }
  }

  clearTokenCache(): void {
    this.logger.log('Clearing Auth0 token cache');
    this.tokenCache = null;
  }
}
