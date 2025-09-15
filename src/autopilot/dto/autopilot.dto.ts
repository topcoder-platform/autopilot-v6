import {
  IsString,
  IsNumber,
  IsEnum,
  IsObject,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { AutopilotOperator } from '../interfaces/autopilot.interface';

export class PhaseTransitionDto {
  @IsDateString()
  date: string;

  @IsNumber()
  projectId: number;

  @IsUUID() // Changed from IsNumber to IsUUID
  phaseId: string; // Changed from number to string

  @IsString()
  phaseTypeName: string;

  @IsEnum(['START', 'END'])
  state: 'START' | 'END';

  @IsEnum(AutopilotOperator)
  operator: AutopilotOperator | string;

  @IsString()
  projectStatus: string;
}

export class ChallengeUpdateDto {
  @IsDateString()
  date: string;

  @IsUUID() // Changed from IsNumber to IsUUID
  challengeId: string; // Changed from number to string

  @IsString()
  status: string;

  @IsEnum(AutopilotOperator)
  operator: AutopilotOperator | string;
}

export class CommandDto {
  @IsDateString()
  date: string;

  @IsString()
  commandId: string;

  @IsString()
  type: string;

  @IsObject()
  parameters: Record<string, any>;

  @IsEnum(AutopilotOperator)
  operator: AutopilotOperator | string;
}
