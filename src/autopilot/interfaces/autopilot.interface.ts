export interface BaseMessage {
  topic: string;
  originator: string;
  timestamp: string;
  mimeType: string;
}

export interface PhaseTransitionPayload {
  projectId: number;
  phaseId: number;
  phaseTypeName: string;
  state: 'START' | 'END';
  operator: string;
  projectStatus: string;
  date?: string;
  challengeId?: number; // Added to meet requirement #6
}

export interface ChallengeUpdatePayload {
  projectId: number;
  challengeId: number;
  status: string;
  operator: string;
  date?: string;
}

export interface CommandPayload {
  command: string;
  operator: string;
  projectId?: number;
  date?: string;
  phaseId?: number; // Keep this to support individual phase cancellation
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
