import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { IPhase, IChallenge } from './interfaces/challenge.interface';
import { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { Auth0Service } from '../auth/auth0.service';

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
  hasWinningSubmission?: boolean;
  updatedPhases?: IPhase[];
  next?: {
    operation?: 'open' | 'close';
    phases?: IPhase[];
  };
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
  private readonly challengeFetchTimeoutMs = 8000;
  private readonly challengeFetchRetryDelayMs = 5000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly auth0Service: Auth0Service,
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

  private async getAuthHeader(): Promise<{ [key: string]: string }> {
    const token = await this.auth0Service.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain, */*',
    };
  }

  async getAllActiveChallenges(
    filters: ChallengeFiltersDto = {},
  ): Promise<IChallenge[]> {
    let allChallenges: IChallenge[] = [];
    let page = 1;
    const perPage = 50; // Reasonable page size for API calls

    while (true) {
      const params = {
        isLightweight: true,
        page,
        perPage,
        ...filters,
      };

      for (let attempt = 1; attempt <= this.apiRetryAttempts; attempt++) {
        try {
          const headers = await this.getAuthHeader();
          const response = await firstValueFrom(
            this.httpService.get<IChallenge[]>(
              `${this.challengeApiUrl}/challenges`,
              { headers, params, timeout: 15000 },
            ),
          );

          const challenges = response.data;

          if (!challenges || challenges.length === 0) {
            // No more challenges to fetch
            return allChallenges;
          }

          allChallenges = [...allChallenges, ...challenges];

          if (challenges.length < perPage) {
            // Last page reached
            return allChallenges;
          }

          // Continue to next page
          page++;
          break;
        } catch (error) {
          const err = error as IChallengeApiError;

          const status = err.response?.status;
          const retryAfter = err.response?.headers?.['retry-after'];

          if (status === 429) {
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : this.apiRetryDelay * Math.pow(2, attempt);
            this.logger.warn(
              `Rate limit exceeded on page ${page}. Retrying after ${delay / 1000} seconds...`,
              { attempt, retries: this.apiRetryAttempts },
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          if (attempt === this.apiRetryAttempts || (status && status < 500)) {
            this.logger.error(
              `Failed to fetch active challenges on page ${page} after ${attempt} attempts: ${err.message}`,
              err.stack,
              {
                status: err.response?.status,
                statusText: err.response?.statusText,
                data: err.response?.data,
                page,
                totalFetched: allChallenges.length,
              },
            );
            // Return what we have collected so far instead of empty array
            return allChallenges;
          }

          const delay = this.apiRetryDelay * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Attempt ${attempt} failed to fetch active challenges on page ${page}. Retrying in ${delay / 1000}s...`,
            { error: err.message },
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  async getChallenge(challengeId: string): Promise<IChallenge | null> {
    const url = `${this.challengeApiUrl}/challenges/${challengeId}`;
    console.log('Fetching challenge from URL:', url);

    // Ensure at least one attempt
    const maxAttempts = Math.max(this.apiRetryAttempts, 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();

      try {
        const headers = await this.getAuthHeader();
        const response = await firstValueFrom(
          this.httpService.get<IChallenge>(url, {
            headers,
            timeout: this.challengeFetchTimeoutMs,
          }),
        );

        const duration = Date.now() - start;
        if (duration >= this.challengeFetchTimeoutMs) {
          this.logger.warn(
            `Challenge API request to ${url} took ${duration}ms (attempt ${attempt})`,
            {
              challengeId,
              timeoutMs: this.challengeFetchTimeoutMs,
            },
          );
        }

        return response.data;
      } catch (error) {
        const err = error as IChallengeApiError;
        const duration = Date.now() - start;

        if (duration >= this.challengeFetchTimeoutMs) {
          this.logger.warn(
            `Challenge API request to ${url} took ${duration}ms (attempt ${attempt})`,
            {
              challengeId,
              timeoutMs: this.challengeFetchTimeoutMs,
              status: err.response?.status,
              error: err.message,
            },
          );
        }

        if (attempt === maxAttempts) {
          this.logger.error(
            `Failed to fetch challenge ${challengeId}: ${err.message}`,
            err.stack,
            {
              status: err.response?.status,
              statusText: err.response?.statusText,
              data: err.response?.data,
              url,
              attempts: maxAttempts,
              timeoutMs: this.challengeFetchTimeoutMs,
              code: err.code,
            },
          );
          return null;
        }

        this.logger.warn(
          `Attempt ${attempt} failed to fetch challenge ${challengeId}. Retrying in ${this.challengeFetchRetryDelayMs / 1000}s...`,
          {
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: err.response?.data,
            url,
            attempt,
            remainingAttempts: maxAttempts - attempt,
            error: err.message,
            code: err.code,
          },
        );

        await new Promise((resolve) =>
          setTimeout(resolve, this.challengeFetchRetryDelayMs),
        );
      }
    }

    return null;
  }

  /**
   * Retrieves a specific challenge by its ID.
   * This method fetches challenge details but does not verify if the challenge is active.
   */
  async getChallengeById(challengeId: string): Promise<IChallenge> {
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
    // Get the phase name from the phase ID - the API expects phase name, not phase ID
    const phaseName = await this.getPhaseTypeName(challengeId, phaseId);
    if (!phaseName || phaseName === 'Unknown') {
      this.logger.error(
        `Cannot advance phase: Phase with ID ${phaseId} not found in challenge ${challengeId}`,
      );
      return {
        success: false,
        message: `Phase with ID ${phaseId} not found in challenge ${challengeId}`,
      };
    }

    const body = { phase: phaseName, operation };
    try {
      const headers = await this.getAuthHeader();
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
      if (err.response?.status === 400) {
        this.logger.warn(
          `Challenge API returned 400 when advancing phase for challenge ${challengeId}`,
          {
            phaseId,
            phaseName,
            operation,
            response: {
              status: err.response.status,
              statusText: err.response.statusText,
              data: err.response.data,
              headers: err.response.headers,
            },
          },
        );
      }
      this.logger.error(
        `Failed to advance phase for challenge ${challengeId}: ${err.message}`,
        err.stack,
        {
          status: err.response?.status,
          statusText: err.response?.statusText,
          data: err.response?.data,
          request: {
            method: 'POST',
            url: `${this.challengeApiUrl}/challenges/${challengeId}/advance-phase`,
            body,
            headers: await this.getAuthHeader().catch(() => ({
              error: 'Failed to get auth header',
            })),
          },
        },
      );
      return { success: false, message: 'Failed to advance phase' };
    }
  }
}
