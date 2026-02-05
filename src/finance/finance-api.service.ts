import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Auth0Service } from '../auth/auth0.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

@Injectable()
export class FinanceApiService {
  private readonly logger = new Logger(FinanceApiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    this.baseUrl = (
      this.configService.get<string>('finance.baseUrl') || ''
    ).trim();
    this.timeoutMs =
      this.configService.get<number>('finance.timeoutMs') ?? 15000;

    if (!this.baseUrl) {
      this.logger.warn(
        'FINANCE_API_URL is not configured. Automatic payment generation is disabled.',
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

  async generateChallengePayments(challengeId: string): Promise<boolean> {
    const url = this.buildUrl(`/challenges/${challengeId}`);
    if (!url) {
      await this.dbLogger.logAction('finance.generatePayments', {
        challengeId,
        status: 'INFO',
        source: FinanceApiService.name,
        details: {
          note: 'FINANCE_API_URL not configured; skipping payment generation call.',
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
      await this.dbLogger.logAction('finance.generatePayments', {
        challengeId,
        status: 'SUCCESS',
        source: FinanceApiService.name,
        details: { url, status, token },
      });
      this.logger.log(
        `Triggered finance payments for challenge ${challengeId} (status ${status}).`,
      );
      return true;
    } catch (error) {
      const err = error;
      const message = err?.message || 'Unknown error';
      const status = err?.response?.status;
      const data = err?.response?.data;

      this.logger.error(
        `Failed to trigger finance payments for challenge ${challengeId}: ${message}`,
        err?.stack,
      );
      await this.dbLogger.logAction('finance.generatePayments', {
        challengeId,
        status: 'ERROR',
        source: FinanceApiService.name,
        details: { url, error: message, status, response: data, token },
      });
      return false;
    }
  }
}
