import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { KafkaMessageTemplate } from './kafka.template';
import { KAFKA_TOPICS } from '../constants/topics';

// Phase Transition Template
export class PhaseTransitionPayload {
  @IsNumber()
  @IsNotEmpty()
  projectId: number;

  @IsUUID() // Changed from IsNumber to IsUUID
  @IsNotEmpty()
  phaseId: string; // Changed from number to string

  @IsString()
  @IsNotEmpty()
  phaseTypeName: string;

  @IsEnum(['START', 'END'])
  state: 'START' | 'END';

  @IsString()
  @IsNotEmpty()
  operator: string;

  @IsString()
  @IsNotEmpty()
  projectStatus: string;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsUUID() // Changed from IsNumber to IsUUID
  @IsOptional()
  challengeId?: string; // Changed from number to string
}

export class PhaseTransitionMessage extends KafkaMessageTemplate<PhaseTransitionPayload> {
  constructor(payload: PhaseTransitionPayload) {
    super(KAFKA_TOPICS.PHASE_TRANSITION, payload);
  }
}

// Challenge Update Template
export class ChallengeUpdatePayload {
  @IsNumber()
  @IsNotEmpty()
  projectId: number;

  @IsUUID() // Changed from IsNumber to IsUUID
  @IsNotEmpty()
  challengeId: string; // Changed from number to string

  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsNotEmpty()
  operator: string;

  @IsDateString()
  @IsOptional()
  date?: string;
}

export class ChallengeUpdateMessage extends KafkaMessageTemplate<ChallengeUpdatePayload> {
  constructor(payload: ChallengeUpdatePayload) {
    super(KAFKA_TOPICS.CHALLENGE_UPDATE, payload);
  }
}

// Command Template
export class CommandPayload {
  @IsString()
  @IsNotEmpty()
  command: string;

  @IsString()
  @IsNotEmpty()
  operator: string;

  @IsNumber()
  @IsOptional()
  projectId?: number;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsUUID() // Changed from IsNumber to IsUUID
  @IsOptional()
  phaseId?: string; // Changed from number to string
}

export class CommandMessage extends KafkaMessageTemplate<CommandPayload> {
  constructor(payload: CommandPayload) {
    super(KAFKA_TOPICS.COMMAND, payload);
  }
}
