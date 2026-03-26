import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Auth0Service } from '../auth/auth0.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

export interface MarathonMatchPhaseConfigResponse {
  configType: string;
  startSeed: number;
  numberOfTests: number;
}

export interface MarathonMatchConfigResponse {
  id: string;
  challengeId: string;
  reviewScorecardId: string;
  relativeScoringEnabled: boolean;
  example: MarathonMatchPhaseConfigResponse | null;
  provisional: MarathonMatchPhaseConfigResponse | null;
  system: MarathonMatchPhaseConfigResponse | null;
}

/**
 * Wraps outbound Marathon Match API calls used by autopilot review orchestration.
 */
@Injectable()
export class MarathonMatchApiService {
  private readonly logger = new Logger(MarathonMatchApiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('marathonMatch.baseUrl') || ''
    ).trim();
    this.timeoutMs =
      this.configService.get<number>('marathonMatch.timeoutMs') ?? 15000;

    if (!this.baseUrl) {
      this.logger.warn(
        'MARATHON_MATCH_API_URL is not configured. Marathon Match orchestration is disabled.',
      );
    }
  }

  /**
   * Fetches the Marathon Match configuration for one challenge.
   * @param challengeId Challenge identifier used by autopilot workflows.
   * @returns Marathon Match config details, or null when the API is unavailable.
   */
  async getConfig(
    challengeId: string,
  ): Promise<MarathonMatchConfigResponse | null> {
    const url = this.buildUrl(
      `/v6/marathon-match/challenge/${encodeURIComponent(challengeId)}`,
    );

    if (!url) {
      await this.dbLogger.logAction('marathonMatch.getConfig', {
        challengeId,
        status: 'INFO',
        source: MarathonMatchApiService.name,
        details: {
          note: 'MARATHON_MATCH_API_URL not configured; skipping config lookup.',
        },
      });
      return null;
    }

    let token: string | undefined;
    const requestLog = {
      method: 'GET',
      url,
      body: null,
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
        this.httpService.get<MarathonMatchConfigResponse>(url, {
          headers: axiosHeaders,
          timeout: this.timeoutMs,
        }),
      );

      await this.dbLogger.logAction('marathonMatch.getConfig', {
        challengeId,
        status: 'SUCCESS',
        source: MarathonMatchApiService.name,
        details: {
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

      return response.data ?? null;
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
        `Failed to load Marathon Match config for challenge ${challengeId}: ${message}`,
        err?.stack,
      );

      await this.dbLogger.logAction('marathonMatch.getConfig', {
        challengeId,
        status: 'ERROR',
        source: MarathonMatchApiService.name,
        details: {
          url,
          request: requestLog,
          error: message,
          status: err?.response?.status,
          response: err?.response?.data,
          responseHeaders: this.sanitizeHeaders(err?.response?.headers),
        },
      });

      return null;
    }
  }

  /**
   * Dispatches the Marathon Match SYSTEM scorer flow for one pending review.
   * @param reviewId Review identifier created in review-api.
   * @param submissionId Submission identifier to score.
   * @param challengeId Challenge identifier used by marathon-match-api.
   * @throws Error when the dispatch request fails.
   */
  async triggerSystemScore(
    reviewId: string,
    submissionId: string,
    challengeId: string,
  ): Promise<void> {
    const url = this.buildUrl('/v6/marathon-match/internal/system-score');

    if (!url) {
      const dispatchError = new Error(
        'MARATHON_MATCH_API_URL not configured; cannot trigger Marathon Match system scoring.',
      );
      await this.dbLogger.logAction('marathonMatch.triggerSystemScore', {
        challengeId,
        status: 'ERROR',
        source: MarathonMatchApiService.name,
        details: {
          reviewId,
          submissionId,
          error: dispatchError.message,
        },
      });
      throw dispatchError;
    }

    let token: string | undefined;
    const body = { reviewId, submissionId, challengeId };
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

      await this.dbLogger.logAction('marathonMatch.triggerSystemScore', {
        challengeId,
        status: 'SUCCESS',
        source: MarathonMatchApiService.name,
        details: {
          reviewId,
          submissionId,
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
        `Failed to trigger Marathon Match system scoring for review ${reviewId}: ${message}`,
        err?.stack,
      );

      await this.dbLogger.logAction('marathonMatch.triggerSystemScore', {
        challengeId,
        status: 'ERROR',
        source: MarathonMatchApiService.name,
        details: {
          reviewId,
          submissionId,
          url,
          request: requestLog,
          error: message,
          status: err?.response?.status,
          response: err?.response?.data,
          responseHeaders: this.sanitizeHeaders(err?.response?.headers),
        },
      });

      throw error;
    }
  }

  private buildUrl(path: string): string | null {
    if (!this.baseUrl) {
      return null;
    }

    const normalizedBase = this.baseUrl.endsWith('/')
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    let normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const servicePrefix = '/v6/marathon-match';

    if (
      normalizedBase.endsWith(servicePrefix) &&
      normalizedPath.startsWith(servicePrefix)
    ) {
      normalizedPath = normalizedPath.slice(servicePrefix.length) || '/';
    }

    return `${normalizedBase}${normalizedPath}`;
  }

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
}
