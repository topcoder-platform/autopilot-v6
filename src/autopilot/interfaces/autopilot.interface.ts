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
  operator: string;
  projectStatus: string;
  date?: string;
  challengeId: string; // Changed to string to support UUIDs
}

export interface ChallengeUpdatePayload {
  projectId: number;
  challengeId: string; // Changed to string to support UUIDs
  status: string;
  operator: string;
  date?: string;
  // This nested structure may be present in Kafka messages from the API
  phases?: {
    id: string;
    scheduledEndDate: string;
  }[];
}

export interface CommandPayload {
  command: string;
  operator: string;
  projectId?: number;
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
