import { KAFKA_TOPICS } from '../constants/topics';
import {
  ChallengeUpdatePayload,
  CommandPayload,
  AppealRespondedPayload,
  First2FinishSubmissionPayload,
  PhaseTransitionPayload,
  ResourceEventPayload,
  ReviewCompletedPayload,
  SubmissionAggregatePayload,
} from 'src/autopilot/interfaces/autopilot.interface';

export type TopicPayloadMap = {
  [KAFKA_TOPICS.PHASE_TRANSITION]: PhaseTransitionPayload;
  [KAFKA_TOPICS.CHALLENGE_UPDATE]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.CHALLENGE_CREATED]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.CHALLENGE_UPDATED]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.COMMAND]: CommandPayload;
  [KAFKA_TOPICS.SUBMISSION_NOTIFICATION_AGGREGATE]: SubmissionAggregatePayload;
  [KAFKA_TOPICS.RESOURCE_CREATED]: ResourceEventPayload;
  [KAFKA_TOPICS.RESOURCE_DELETED]: ResourceEventPayload;
  [KAFKA_TOPICS.REVIEW_COMPLETED]: ReviewCompletedPayload;
  [KAFKA_TOPICS.REVIEW_APPEAL_RESPONDED]: AppealRespondedPayload;
  [KAFKA_TOPICS.FIRST2FINISH_SUBMISSION_RECEIVED]: First2FinishSubmissionPayload;
};
