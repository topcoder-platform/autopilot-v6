import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { IPhase, IChallenge } from './interfaces/challenge.interface';
import { AxiosError, InternalAxiosRequestConfig } from 'axios';

// DTO for filtering challenges
interface ChallengeFiltersDto {
  status?: string;
  isLightweight?: boolean;
  page?: number;
  perPage?: number;
}

// DTO for the response of the advance-phase endpoint
interface PhaseAdvanceResponseDto {
  success: boolean;
  message: string;
}

// Corrected: Interface to correctly extend AxiosError for type safety
interface IChallengeApiErrorResponse {
  data: Record<string, unknown>;
  status: number;
  statusText: string;
  headers: {
    'retry-after'?: string;
  };
  config: InternalAxiosRequestConfig;
}

interface IChallengeApiError extends AxiosError {
  response?: IChallengeApiErrorResponse;
}

@Injectable()
export class ChallengeApiService {
  private readonly logger = new Logger(ChallengeApiService.name);
  private readonly challengeApiUrl: string;
  private readonly apiRetryAttempts: number;
  private readonly apiRetryDelay: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.challengeApiUrl = this.configService.get<string>(
      'challenge.apiUrl',
      'http://localhost:3001',
    );
    this.apiRetryAttempts = this.configService.get<number>(
      'challenge.retry.attempts',
      3,
    );
    this.apiRetryDelay = this.configService.get<number>(
      'challenge.retry.initialDelay',
      1000,
    );
  }

  private getAuthHeader(): { [key: string]: string } {
    const token = this.configService.get<string>(
      'challenge.m2mToken',
      'dummy-token',
    );
    return {
      Authorization: `Bearer ${token}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
    };
  }

  async getAllActiveChallenges(
    filters: ChallengeFiltersDto = {},
  ): Promise<IChallenge[]> {
    const headers = this.getAuthHeader();
    const params = {
      isLightweight: true,
      ...filters,
    };

    for (let attempt = 1; attempt <= this.apiRetryAttempts; attempt++) {
      try {
        const response = await firstValueFrom(
          this.httpService.get<IChallenge[]>(
            `${this.challengeApiUrl}/challenges`,
            { headers, params, timeout: 15000 },
          ),
        );
        return response.data;
      } catch (error) {
        const err = error as IChallengeApiError;

        const status = err.response?.status;
        const retryAfter = err.response?.headers?.['retry-after'];

        if (status === 429) {
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : this.apiRetryDelay * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limit exceeded. Retrying after ${delay / 1000} seconds...`,
            { attempt, retries: this.apiRetryAttempts },
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (attempt === this.apiRetryAttempts || (status && status < 500)) {
          this.logger.error(
            `Failed to fetch active challenges after ${attempt} attempts: ${err.message}`,
            err.stack,
            {
              status: err.response?.status,
              statusText: err.response?.statusText,
              data: err.response?.data,
            },
          );
          return [];
        }

        const delay = this.apiRetryDelay * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Attempt ${attempt} failed to fetch active challenges. Retrying in ${delay / 1000}s...`,
          { error: err.message },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return [];
  }

  async getChallenge(challengeId: string): Promise<IChallenge | null> {
    const headers = this.getAuthHeader();
    try {
      const response = await firstValueFrom(
        this.httpService.get<IChallenge>(
          `${this.challengeApiUrl}/challenges/${challengeId}`,
          { headers, timeout: 5000 },
        ),
      );
      return response.data;
    } catch (error) {
      const err = error as IChallengeApiError;
      this.logger.error(
        `Failed to fetch challenge ${challengeId}: ${err.message}`,
        err.stack,
        {
          status: err.response?.status,
          statusText: err.response?.statusText,
          data: err.response?.data,
        },
      );
      return null;
    }
  }

  /**
   * Added to match the requirement's example interface.
   * This is an alias for the getChallenge method.
   */
  async getActiveChallenge(challengeId: string): Promise<IChallenge> {
    const challenge = await this.getChallenge(challengeId);
    if (!challenge) {
      throw new NotFoundException(
        `Challenge with ID ${challengeId} not found.`,
      );
    }
    return challenge;
  }

  async getChallengePhases(challengeId: string): Promise<IPhase[]> {
    const challenge = await this.getChallenge(challengeId);
    return challenge?.phases || [];
  }

  async getPhaseDetails(
    challengeId: string,
    phaseId: string,
  ): Promise<IPhase | null> {
    const phases = await this.getChallengePhases(challengeId);
    return phases.find((p) => p.id === phaseId) || null;
  }

  async getPhaseTypeName(
    challengeId: string,
    phaseId: string,
  ): Promise<string> {
    const phase = await this.getPhaseDetails(challengeId, phaseId);
    return phase?.name || 'Unknown';
  }

  async advancePhase(
    challengeId: string,
    phaseId: string,
    operation: 'open' | 'close',
  ): Promise<PhaseAdvanceResponseDto> {
    const headers = this.getAuthHeader();
    const body = { phaseId, operation };
    try {
      const response = await firstValueFrom(
        this.httpService.post<PhaseAdvanceResponseDto>(
          `${this.challengeApiUrl}/challenges/${challengeId}/advance-phase`,
          body,
          { headers, timeout: 10000 },
        ),
      );
      return response.data;
    } catch (error) {
      const err = error as IChallengeApiError;
      this.logger.error(
        `Failed to advance phase for challenge ${challengeId}: ${err.message}`,
        err.stack,
        {
          status: err.response?.status,
          statusText: err.response?.statusText,
          data: err.response?.data,
        },
      );
      return { success: false, message: 'Failed to advance phase' };
    }
  }
}
