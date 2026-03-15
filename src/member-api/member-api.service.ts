import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Auth0Service } from '../auth/auth0.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

/**
 * Wraps outbound member-api calls used to refresh and rerate member statistics
 * after challenge completion workflows finish in autopilot.
 */
@Injectable()
export class MemberApiService {
  private readonly logger = new Logger(MemberApiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('memberApi.baseUrl') || ''
    ).trim();
    this.timeoutMs =
      this.configService.get<number>('memberApi.timeoutMs') ?? 15000;

    if (!this.baseUrl) {
      this.logger.warn(
        'MEMBER_API_URL is not configured. Automatic member stats refresh is disabled.',
      );
    }
  }

  /**
   * Builds an absolute outbound URL for the configured member-api service.
   * @param path Relative API path to append to the configured base URL.
   * @returns Fully qualified URL, or `null` when the service is disabled.
   * @throws Never. Missing configuration returns `null`.
   */
  private buildUrl(path: string): string | null {
    if (!this.baseUrl) {
      return null;
    }

    const normalizedBase = this.baseUrl.endsWith('/')
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  /**
   * Redacts sensitive response header values before they are written to debug logs.
   * @param headers Raw response headers captured from axios.
   * @returns A sanitized header object safe to include in DB debug logs.
   * @throws Never. Undefined input returns undefined.
   */
  private sanitizeHeaders(
    headers: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!headers) {
      return undefined;
    }

    return Object.entries(headers).reduce<Record<string, unknown>>(
      (sanitized, [key, value]) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'authorization' || lowerKey === 'set-cookie') {
          sanitized[key] = '[redacted]';
        } else {
          sanitized[key] = value;
        }

        return sanitized;
      },
      {},
    );
  }

  /**
   * Triggers a member stats refresh in member-api for one completed challenge winner.
   * @param handle Member handle whose aggregate stats should be refreshed.
   * @param challengeId Optional challenge identifier used to scope the refresh request.
   * @returns `true` when member-api accepts the request with a 2xx response, otherwise `false`.
   * @throws Never. All transport and API errors are logged and converted to `false`.
   *
   * Usage:
   * Called by `ChallengeCompletionService` after a challenge is marked complete so
   * member-api can recompute the winner's statistics without blocking completion.
   */
  async refreshMemberStats(
    handle: string,
    challengeId?: string,
  ): Promise<boolean> {
    const url = this.buildUrl(
      `/v6/members/${encodeURIComponent(handle)}/stats/refresh`,
    );
    const body = challengeId ? { challengeId } : {};

    if (!url) {
      await this.dbLogger.logAction('memberApi.refreshMemberStats', {
        challengeId: challengeId ?? null,
        status: 'INFO',
        source: MemberApiService.name,
        details: {
          handle,
          note: 'MEMBER_API_URL not configured; skipping member stats refresh call.',
        },
      });
      return false;
    }

    let token: string | undefined;
    const requestLog = {
      method: 'POST',
      url,
      body,
      headers: {
        Authorization: '[not available]',
        'Content-Type': 'application/json',
      },
      timeoutMs: this.timeoutMs,
    };

    try {
      token = await this.auth0Service.getAccessToken();
      if (token) {
        requestLog.headers.Authorization = 'Bearer [redacted]';
      }

      const axiosHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        axiosHeaders.Authorization = `Bearer ${token}`;
      }

      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: axiosHeaders,
          timeout: this.timeoutMs,
        }),
      );

      await this.dbLogger.logAction('memberApi.refreshMemberStats', {
        challengeId: challengeId ?? null,
        status: 'SUCCESS',
        source: MemberApiService.name,
        details: {
          handle,
          url,
          status: response.status,
          request: requestLog,
          response: {
            status: response.status,
            data: response.data ?? null,
            headers: this.sanitizeHeaders(
              response.headers as Record<string, unknown> | undefined,
            ),
          },
        },
      });

      this.logger.log(
        `Triggered member stats refresh for handle ${handle} (${response.status}).`,
      );
      return true;
    } catch (error) {
      const err = error as {
        message?: string;
        stack?: string;
        response?: {
          status?: number;
          data?: unknown;
          headers?: Record<string, unknown>;
        };
      };
      const message = err?.message || 'Unknown error';

      this.logger.error(
        `Failed to refresh member stats for handle ${handle}: ${message}`,
        err?.stack,
      );

      await this.dbLogger.logAction('memberApi.refreshMemberStats', {
        challengeId: challengeId ?? null,
        status: 'ERROR',
        source: MemberApiService.name,
        details: {
          handle,
          url,
          request: requestLog,
          error: message,
          status: err?.response?.status,
          response: err?.response?.data,
          responseHeaders: this.sanitizeHeaders(err?.response?.headers),
        },
      });
      return false;
    }
  }

  /**
   * Triggers a member stats rerate in member-api for one rated challenge winner.
   * @param handle Member handle whose rating should be recomputed.
   * @param challengeId Challenge identifier associated with the completed rated challenge.
   * @param trackId Challenge track identifier required by member-api rerating.
   * @param typeId Challenge type identifier required by member-api rerating.
   * @returns `true` when member-api accepts the request with a 2xx response, otherwise `false`.
   * @throws Never. All transport and API errors are logged and converted to `false`.
   *
   * Usage:
   * Called by `ChallengeCompletionService` after a rated challenge completes so
   * member-api can update the winner's rating without blocking challenge completion.
   */
  async rerateMemberStats(
    handle: string,
    challengeId: string,
    trackId: string,
    typeId: string,
  ): Promise<boolean> {
    const url = this.buildUrl(
      `/v6/members/${encodeURIComponent(handle)}/stats/rerate`,
    );
    const body = { challengeId, trackId, typeId };

    if (!url) {
      await this.dbLogger.logAction('memberApi.rerateMemberStats', {
        challengeId,
        status: 'INFO',
        source: MemberApiService.name,
        details: {
          handle,
          trackId,
          typeId,
          note: 'MEMBER_API_URL not configured; skipping member stats rerate call.',
        },
      });
      return false;
    }

    let token: string | undefined;
    const requestLog = {
      method: 'POST',
      url,
      body,
      headers: {
        Authorization: '[not available]',
        'Content-Type': 'application/json',
      },
      timeoutMs: this.timeoutMs,
    };

    try {
      token = await this.auth0Service.getAccessToken();
      if (token) {
        requestLog.headers.Authorization = 'Bearer [redacted]';
      }

      const axiosHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        axiosHeaders.Authorization = `Bearer ${token}`;
      }

      const response = await firstValueFrom(
        this.httpService.post<Record<string, unknown>>(url, body, {
          headers: axiosHeaders,
          timeout: this.timeoutMs,
        }),
      );

      await this.dbLogger.logAction('memberApi.rerateMemberStats', {
        challengeId,
        status: 'SUCCESS',
        source: MemberApiService.name,
        details: {
          handle,
          trackId,
          typeId,
          url,
          status: response.status,
          request: requestLog,
          response: {
            status: response.status,
            data: response.data ?? null,
            headers: this.sanitizeHeaders(
              response.headers as Record<string, unknown> | undefined,
            ),
          },
        },
      });

      this.logger.log(
        `Triggered member stats rerate for handle ${handle} (${response.status}).`,
      );
      return true;
    } catch (error) {
      const err = error as {
        message?: string;
        stack?: string;
        response?: {
          status?: number;
          data?: unknown;
          headers?: Record<string, unknown>;
        };
      };
      const message = err?.message || 'Unknown error';

      this.logger.error(
        `Failed to rerate member stats for handle ${handle}: ${message}`,
        err?.stack,
      );

      await this.dbLogger.logAction('memberApi.rerateMemberStats', {
        challengeId,
        status: 'ERROR',
        source: MemberApiService.name,
        details: {
          handle,
          trackId,
          typeId,
          url,
          request: requestLog,
          error: message,
          status: err?.response?.status,
          response: err?.response?.data,
          responseHeaders: this.sanitizeHeaders(err?.response?.headers),
        },
      });
      return false;
    }
  }
}
