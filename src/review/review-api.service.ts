import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Auth0Service } from '../auth/auth0.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import { CreateReviewOpportunityDto } from './dto/create-review-opportunity.dto';

@Injectable()
export class ReviewApiService {
  private readonly logger = new Logger(ReviewApiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('review.baseUrl') || ''
    ).trim();
    this.timeoutMs =
      this.configService.get<number>('review.timeoutMs') ?? 15000;

    if (!this.baseUrl) {
      this.logger.warn(
        'REVIEW_API_URL is not configured. Review opportunity creation is disabled.',
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

  async createReviewOpportunity(
    dto: CreateReviewOpportunityDto,
  ): Promise<Record<string, any> | null> {
    const url = this.buildUrl('/review-opportunities');
    if (!url) {
      await this.dbLogger.logAction('review.createOpportunity', {
        status: 'INFO',
        source: ReviewApiService.name,
        details: {
          note: 'REVIEW_API_URL not configured; skipping review opportunity creation call.',
          dto,
        },
      });
      return null;
    }

    const payload = {
      ...dto,
      status: dto.status ?? 'OPEN',
      type: dto.type ?? 'REGULAR_REVIEW',
    };

    let token: string | undefined;
    try {
      token = await this.auth0Service.getAccessToken();
      const response = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }),
      );

      await this.dbLogger.logAction('review.createOpportunity', {
        status: 'SUCCESS',
        source: ReviewApiService.name,
        details: {
          url,
          status: response.status,
          token,
          payload,
        },
      });
      this.logger.log(
        `Created review opportunity for challenge ${dto.challengeId} (status ${response.status}).`,
      );
      return response.data;
    } catch (error) {
      const err = error;
      const message = err?.message || 'Unknown error';
      const status = err?.response?.status;
      const data = err?.response?.data;

      this.logger.error(
        `Failed to create review opportunity for challenge ${dto.challengeId}: ${message}`,
        err?.stack,
      );
      await this.dbLogger.logAction('review.createOpportunity', {
        status: 'ERROR',
        source: ReviewApiService.name,
        details: {
          url,
          error: message,
          status,
          response: data,
          token,
          payload,
        },
      });
      return null;
    }
  }

  async getReviewOpportunitiesByChallengeId(
    challengeId: string,
  ): Promise<any[]> {
    const url = this.buildUrl(`/review-opportunities/challenge/${challengeId}`);
    if (!url) {
      await this.dbLogger.logAction('review.getOpportunitiesByChallenge', {
        status: 'INFO',
        source: ReviewApiService.name,
        details: {
          note: 'REVIEW_API_URL not configured; skipping review opportunity retrieval.',
          challengeId,
        },
      });
      return [];
    }

    let token: string | undefined;
    try {
      token = await this.auth0Service.getAccessToken();
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }),
      );
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      const err = error;
      const message = err?.message || 'Unknown error';
      const status = err?.response?.status;
      const data = err?.response?.data;

      this.logger.error(
        `Failed to fetch review opportunities for challenge ${challengeId}: ${message}`,
        err?.stack,
      );
      await this.dbLogger.logAction('review.getOpportunitiesByChallenge', {
        status: 'ERROR',
        source: ReviewApiService.name,
        details: {
          url,
          error: message,
          status,
          response: data,
          token,
          challengeId,
        },
      });
      return [];
    }
  }
}
