import { Injectable, Logger } from '@nestjs/common';
import { IPhase } from './challenge.service';

/**
 * Service to fetch phase details from challenge updates
 * This separates the concerns and avoids modifying the original payload interfaces
 */
@Injectable()
export class ChallengeApiService {
  private readonly logger = new Logger(ChallengeApiService.name);

  /**
   * Mock implementation to fetch phase details for a challenge
   * In a real implementation, this would call the Challenge API
   */
  async getPhaseDetails(
    projectId: number,
    phaseId: number,
  ): Promise<IPhase | null> {
    // This is a mock implementation - in production, this would call the Challenge API
    this.logger.log(
      `Fetching phase details for project ${projectId}, phase ${phaseId}`,
    );

    // Mock data - in production this would come from the API
    const mockPhases: Record<string, IPhase> = {
      // Key format: `${projectId}:${phaseId}`
      '100:101': {
        id: 101,
        projectId: 100,
        phaseTypeName: 'Registration',
        date: new Date(Date.now() + 60000).toISOString(),
      },
      '100:102': {
        id: 102,
        projectId: 100,
        phaseTypeName: 'Submission',
        date: new Date(Date.now() + 120000).toISOString(),
      },
    };

    const key = `${projectId}:${phaseId}`;
    const phase = mockPhases[key];

    if (!phase) {
      this.logger.warn(`Phase details not found for ${key}`);
      return null;
    }

    // Add an await to satisfy the linter
    await Promise.resolve();

    return phase;
  }

  /**
   * Get phase type name for a phase
   * In a real implementation, this would call the Challenge API
   */
  async getPhaseTypeName(projectId: number, phaseId: number): Promise<string> {
    const phase = await this.getPhaseDetails(projectId, phaseId);
    return phase?.phaseTypeName || 'UNKNOWN';
  }
}
