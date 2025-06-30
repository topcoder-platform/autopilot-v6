import { Injectable } from '@nestjs/common';
export interface IPhase {
  id: number;
  projectId: number;
  phaseTypeName: string;
  date: string;
}
/**
 * Stub implementation of ChallengeService.
 * This is a placeholder until the actual Challenge API integration is complete.
 */
@Injectable()
export class ChallengeService {
  getActivePhases(): IPhase[] {
    // API integration will go here in future
    const activePhases: IPhase[] = [
      {
        projectId: 101,
        id: 201,
        phaseTypeName: 'Submission',
        date: new Date(Date.now() + 5000).toISOString(),
      },
      {
        projectId: 102,
        id: 202,
        phaseTypeName: 'Review',
        date: new Date(Date.now() + 10000).toISOString(), // 10 seconds from now
      },
    ];
    return activePhases;
  }
}
