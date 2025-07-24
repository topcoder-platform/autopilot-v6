import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  ValidateNested,
  IsEnum,
  IsNumber,
  IsOptional,
  IsDateString,
  IsUUID,
} from 'class-validator';

export enum PhaseState {
  START = 'START',
  END = 'END',
}

export class PhaseTransitionPayloadDto {
  @IsNumber()
  @IsNotEmpty()
  projectId: number;

  @IsUUID() // Changed from IsNumber to IsUUID
  @IsNotEmpty()
  phaseId: string; // Changed from number to string

  @IsString()
  @IsNotEmpty()
  phaseTypeName: string;

  @IsEnum(PhaseState)
  state: PhaseState;

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

export class ChallengeUpdatePayloadDto {
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

export class CommandPayloadDto {
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

export class BaseMessageDto {
  @IsString()
  @IsNotEmpty()
  topic: string;

  @IsString()
  @IsNotEmpty()
  originator: string = 'auto_pilot';

  @IsString()
  @IsNotEmpty()
  timestamp: string;

  @IsString()
  @IsNotEmpty()
  'mime-type': string = 'application/json';
}

export class PhaseTransitionMessageDto extends BaseMessageDto {
  @ValidateNested()
  @Type(() => PhaseTransitionPayloadDto)
  payload: PhaseTransitionPayloadDto;
}

export class ChallengeUpdateMessageDto extends BaseMessageDto {
  @ValidateNested()
  @Type(() => ChallengeUpdatePayloadDto)
  payload: ChallengeUpdatePayloadDto;
}

export class CommandMessageDto extends BaseMessageDto {
  @ValidateNested()
  @Type(() => CommandPayloadDto)
  payload: CommandPayloadDto;
}
