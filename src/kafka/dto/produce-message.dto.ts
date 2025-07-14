import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  ValidateNested,
  IsEnum,
  IsNumber,
  IsOptional,
  IsDateString,
} from 'class-validator';

export enum PhaseState {
  START = 'START',
  END = 'END',
}

export class PhaseTransitionPayloadDto {
  @IsNumber()
  @IsNotEmpty()
  projectId: number;

  @IsNumber()
  @IsNotEmpty()
  phaseId: number;

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

  @IsNumber()
  @IsOptional()
  challengeId?: number;
}

export class ChallengeUpdatePayloadDto {
  @IsNumber()
  @IsNotEmpty()
  projectId: number;

  @IsNumber()
  @IsNotEmpty()
  challengeId: number;

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

  @IsNumber()
  @IsOptional()
  phaseId?: number;
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
