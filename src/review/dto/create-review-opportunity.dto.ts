export class CreateReviewOpportunityDto {
  challengeId!: string;
  status?: string;
  type?: string;
  openPositions!: number;
  startDate!: string;
  duration!: number;
  basePayment!: number;
  incrementalPayment!: number;
}
