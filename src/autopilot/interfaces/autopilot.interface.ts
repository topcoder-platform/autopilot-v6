export enum AutopilotOperator {
  // System operators for internal autopilot operations
  SYSTEM = 'system',
  SYSTEM_SCHEDULER = 'system-scheduler',
  SYSTEM_NEW_CHALLENGE = 'system-new-challenge',
  SYSTEM_RECOVERY = 'system-recovery',
  SYSTEM_SYNC = 'system-sync',
  SYSTEM_PHASE_CHAIN = 'system-phase-chain',

  // Administrative operators
  ADMIN = 'admin',

  // User operators (when operator comes from external sources)
  USER = 'user',
}

export interface BaseMessage {
  topic: string;
  originator: string;
  timestamp: string;
  mimeType: string;
}

export interface PhaseTransitionPayload {
  projectId: number;
  phaseId: string; // Changed from number to string to support UUIDs from the API
  phaseTypeName: string;
  state: 'START' | 'END';
  operator: AutopilotOperator | string; // Allow both enum and string for flexibility
  projectStatus: string;
  date?: string;
  challengeId: string; // Changed to string to support UUIDs
  preventFinalization?: boolean;
  // When closing Iterative Review phases after a passing score, skip follow-up iterative processing
  skipIterativePhaseRefresh?: boolean;
}

export interface ChallengeUpdatePayload {
  projectId: number;
  id: string; // Changed to string to support UUIDs
  status: string;
  operator: AutopilotOperator | string; // Allow both enum and string for flexibility
  date?: string;
  // This nested structure may be present in Kafka messages from the API
  phases?: {
    id: string;
    scheduledEndDate: string;
  }[];
}

export interface CommandPayload {
  command: string;
  operator: AutopilotOperator | string; // Allow both enum and string for flexibility
  projectId?: number;
  challengeId?: string; // Added challengeId for new command handling
  date?: string;
  phaseId?: string; // Changed from number to string
}

export interface PhaseTransitionMessage extends BaseMessage {
  payload: PhaseTransitionPayload;
}

export interface ChallengeUpdateMessage extends BaseMessage {
  payload: ChallengeUpdatePayload;
}

export interface CommandMessage extends BaseMessage {
  payload: CommandPayload;
}

export interface SubmissionAggregatePayload {
  resource: string;
  id: string;
  type?: string;
  memberId?: number;
  challengeId?: number;
  legacyChallengeId?: number;
  v5ChallengeId?: string;
  submissionPhaseId?: string;
  fileType?: string;
  submittedDate?: string;
  url?: string;
  isFileSubmission?: boolean;
  created?: string;
  updated?: string;
  createdBy?: string;
  updatedBy?: string;
  originalTopic?: string;
  [key: string]: unknown;
}

export interface ResourceEventPayload {
  id: string;
  challengeId: string;
  memberId: string;
  memberHandle: string;
  roleId: string;
  created: string;
  createdBy: string;
}

export interface ReviewCompletedPayload {
  challengeId: string;
  submissionId: string;
  reviewId: string;
  phaseId: string;
  scorecardId: string;
  reviewerResourceId: string;
  reviewerHandle: string;
  reviewerMemberId: string;
  submitterHandle: string;
  submitterMemberId: string;
  completedAt: string;
  initialScore: number;
}

export interface AppealRespondedPayload {
  challengeId: string;
  submissionId: string;
  reviewId: string;
  scorecardId: string;
  appealId: string;
  appealResponseId: string;
  reviewerResourceId: string;
  reviewerHandle: string;
  reviewerMemberId: string;
  submitterHandle: string;
  submitterMemberId: string;
  reviewCompletedAt: string;
  finalScore: number;
}

export interface First2FinishSubmissionPayload {
  challengeId: string;
  submissionId: string;
  memberId: string;
  memberHandle: string;
  submittedAt: string;
}

export type TopgearSubmissionPayload = First2FinishSubmissionPayload;
