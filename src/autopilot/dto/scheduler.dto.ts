import { IsISO8601, IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class PhaseTransitionScheduleDto {
  @IsUUID() // Changed from IsNumber to IsUUID
  challengeId: string; // Changed from number to string

  @IsUUID() // Changed from IsNumber to IsUUID
  phaseId: string; // Changed from number to string

  @IsString()
  @IsNotEmpty()
  phaseTypeName: string;

  @IsISO8601()
  endTime: string;
}
