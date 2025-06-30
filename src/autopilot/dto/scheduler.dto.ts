import { IsISO8601, IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class PhaseTransitionScheduleDto {
  @IsNumber()
  challengeId: number;

  @IsNumber()
  phaseId: number;

  @IsString()
  @IsNotEmpty()
  phaseTypeName: string;

  @IsISO8601()
  endTime: string;
}
