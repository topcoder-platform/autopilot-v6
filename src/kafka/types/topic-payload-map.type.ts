import { KAFKA_TOPICS } from '../constants/topics';
import {
  ChallengeUpdatePayload,
  CommandPayload,
  PhaseTransitionPayload,
} from 'src/autopilot/interfaces/autopilot.interface';

export type TopicPayloadMap = {
  [KAFKA_TOPICS.PHASE_TRANSITION]: PhaseTransitionPayload;
  [KAFKA_TOPICS.CHALLENGE_UPDATE]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.CHALLENGE_CREATED]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.CHALLENGE_UPDATED]: ChallengeUpdatePayload;
  [KAFKA_TOPICS.COMMAND]: CommandPayload;
};
