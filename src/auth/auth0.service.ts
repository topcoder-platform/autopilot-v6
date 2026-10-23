import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { auth } from 'tc-core-library-js';

interface Auth0TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Auth0TokenCache {
  token: string;
  expiresAt: number;
}

/**
 * Outbound M2M token provider shared by every API client (the DI name predates Keycloak).
 *
 * The provider is chosen once, at construction, by `USE_KEYCLOAK` (decided by
 * `auth.useKeycloak()` in tc-core-library-js):
 * - `true`: the shared core Keycloak provider, using `KEYCLOAK_TOKEN_URL`,
 *   `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` and optional
 *   `KEYCLOAK_SCOPE`. The core verifies, caches and expires the tokens.
 * - unset or `false`: the pre-migration Auth0 client-credentials request to `AUTH0_URL`
 *   with `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and `AUTH0_AUDIENCE` (the `auth0` config
 *   section), cached in this instance until 60 seconds before `expires_in`.
 */
@Injectable()
export class Auth0Service {
  private readonly logger = new Logger(Auth0Service.name);
  private readonly m2m?: ReturnType<typeof auth.m2m>;
  private readonly auth0Url: string = '';
  private readonly clientId: string = '';
  private readonly clientSecret: string = '';
  private readonly audience: string = '';
  private tokenCache: Auth0TokenCache | null = null;

  /**
   * Select the token provider.
   * @param httpService HTTP client for the Auth0 token request (unused in Keycloak mode).
   * @param configService Source of the `auth0.*` settings (unused in Keycloak mode).
   * @throws TypeError when USE_KEYCLOAK is not true/false, or (Keycloak mode) for invalid
   * Keycloak configuration. Missing Auth0 settings are logged, not thrown, as before.
   */
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    if (auth.useKeycloak()) {
      this.m2m = auth.m2m();
      return;
    }

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

  /**
   * Return a cached or new M2M token from the active provider.
   * Takes no arguments. In Keycloak mode the token is verified by the core and its
   * sanitized issuance/configuration errors propagate; in Auth0 mode a failed request
   * rejects with "Failed to obtain Auth0 access token".
   */
  getAccessToken(): Promise<string> {
    if (this.m2m) {
      return this.m2m.getMachineToken();
    }
    return this.getAuth0AccessToken();
  }

  /**
   * Clear the cached token after an upstream 401 so the next call requests a new one.
   * Takes no arguments, returns nothing and does not throw.
   */
  clearTokenCache(): void {
    if (this.m2m) {
      this.m2m.clearCache();
      return;
    }
    this.logger.log('Clearing Auth0 token cache');
    this.tokenCache = null;
  }

  /**
   * Auth0 mode: POST the client-credentials grant to `AUTH0_URL` and cache the token.
   * Takes no arguments; returns the access token; rejects with a generic error (the
   * cause is logged) when the request fails.
   */
  private async getAuth0AccessToken(): Promise<string> {
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
}
