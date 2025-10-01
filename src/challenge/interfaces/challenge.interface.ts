/**
 * @file This file contains the type definitions for the data structures
 * returned by the external Challenge API, matching the provided JSON response.
 */

import type { PrizeSetTypeEnum } from '@prisma/client';

/**
 * Represents a single phase of a challenge.
 */
export interface IPhase {
  id: string;
  phaseId: string;
  name: string;
  description: string | null;
  isOpen: boolean;
  duration: number;
  scheduledStartDate: string;
  scheduledEndDate: string;
  actualStartDate: string | null;
  actualEndDate: string | null;
  predecessor: string | null;
  constraints: any[];
}

export interface IChallengeReviewer {
  id: string;
  scorecardId: string;
  isMemberReview: boolean;
  memberReviewerCount: number | null;
  phaseId: string;
  basePayment: number | null;
  incrementalPayment: number | null;
  type: string | null;
  aiWorkflowId: string | null;
}

export interface IChallengeWinner {
  userId: number;
  handle: string;
  placement: number;
  type?: string;
}

export interface IChallengePrize {
  type: string;
  value: number;
  description: string | null;
}

export interface IChallengePrizeSet {
  type: PrizeSetTypeEnum;
  description: string | null;
  prizes: IChallengePrize[];
}

/**
 * Represents a full challenge object from the Challenge API.
 */
export interface IChallenge {
  id: string;
  name: string;
  description: string | null;
  descriptionFormat: string;
  projectId: number;
  typeId: string;
  trackId: string;
  timelineTemplateId: string;
  currentPhaseNames: string[];
  tags: string[];
  groups: any[];
  submissionStartDate: string;
  submissionEndDate: string;
  registrationStartDate: string;
  registrationEndDate: string;
  startDate: string;
  endDate: string | null;
  legacyId: number | null;
  status: string;
  createdBy: string;
  updatedBy: string;
  metadata: any[];
  phases: IPhase[];
  reviewers: IChallengeReviewer[];
  winners: IChallengeWinner[];
  discussions: any[];
  events: any[];
  prizeSets: IChallengePrizeSet[];
  terms: any[];
  skills: any[];
  attachments: any[];
  track: string;
  type: string;
  legacy: object;
  task: object;
  created: string;
  updated: string;
  overview: object;
  numOfSubmissions: number;
  numOfCheckpointSubmissions: number;
  numOfRegistrants: number;
}
