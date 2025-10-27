import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Auth0Service } from '../../auth/auth0.service';
import { AutopilotDbLoggerService } from './autopilot-db-logger.service';

@Injectable()
export class ReviewSummationApiService {
  private readonly logger = new Logger(ReviewSummationApiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    this.baseUrl =
      (this.configService.get<string>('review.summationApiUrl') || '').trim();
    this.timeoutMs =
      this.configService.get<number>('review.summationApiTimeoutMs') ?? 15000;

    if (!this.baseUrl) {
      this.logger.warn(
        'REVIEW_SUMMATION_API_URL is not configured. Automatic review summation finalization is disabled.',
      );
    }
  }

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

  async finalizeSummations(challengeId: string): Promise<boolean> {
    const url = this.buildUrl(
      `/reviewSummations/challenges/${challengeId}/final`,
    );

    if (!url) {
      await this.dbLogger.logAction('reviewSummation.finalize', {
        challengeId,
        status: 'INFO',
        source: ReviewSummationApiService.name,
        details: {
          note: 'REVIEW_SUMMATION_API_URL not configured; skipping finalize call.',
        },
      });
      return false;
    }

    let token: string | undefined;

    try {
      token = await this.auth0Service.getAccessToken();
      const response = await firstValueFrom(
        this.httpService.post(url, undefined, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }),
      );

      const status = response.status;
      await this.dbLogger.logAction('reviewSummation.finalize', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewSummationApiService.name,
        details: {
          url,
          status,
        },
      });

      this.logger.log(
        `Finalized review summations for challenge ${challengeId} (status ${status}).`,
      );
      return true;
    } catch (error) {
      const err = error as any;
      const message = err?.message || 'Unknown error';
      const status = err?.response?.status;
      const data = err?.response?.data;

      this.logger.error(
        `Failed to finalize review summations for challenge ${challengeId}: ${message}`,
        err?.stack,
      );

      await this.dbLogger.logAction('reviewSummation.finalize', {
        challengeId,
        status: 'ERROR',
        source: ReviewSummationApiService.name,
        details: {
          url,
          error: message,
          status,
          response: data,
        },
      });

      return false;
    }
  }
}
