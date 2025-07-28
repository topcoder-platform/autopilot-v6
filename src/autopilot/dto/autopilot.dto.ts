import {
  IsString,
  IsNumber,
  IsEnum,
  IsObject,
  IsDateString,
  IsUUID,
} from 'class-validator';

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

  @IsString()
  operator: string;

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

  @IsString()
  operator: string;
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

  @IsString()
  operator: string;
}
