import { KAFKA_TOPICS } from '../../kafka/constants/topics';

export const KAFKA_SCHEMAS = {
  [KAFKA_TOPICS.PHASE_TRANSITION]: {
    type: 'record',
    name: 'PhaseTransition',
    namespace: 'com.autopilot.events',
    fields: [
      { name: 'topic', type: 'string', default: 'autopilot.phase.transition' },
      { name: 'originator', type: 'string', default: 'auto_pilot' },
      { name: 'timestamp', type: 'string' },
      { name: 'mimeType', type: 'string', default: 'application/json' },
      {
        name: 'payload',
        type: {
          type: 'record',
          name: 'PhaseTransitionPayload',
          fields: [
            { name: 'projectId', type: 'long' },
            { name: 'phaseId', type: 'string' }, // UUID string
            { name: 'phaseTypeName', type: 'string' },
            {
              name: 'state',
              type: {
                type: 'enum',
                name: 'PhaseState',
                symbols: ['START', 'END'],
              },
            },
            { name: 'operator', type: 'string' },
            { name: 'projectStatus', type: 'string' },
            { name: 'date', type: 'string' },
            { name: 'challengeId', type: 'string' }, // UUID string
          ],
        },
      },
    ],
  },
  [KAFKA_TOPICS.CHALLENGE_UPDATE]: {
    type: 'record',
    name: 'ChallengeUpdate',
    namespace: 'com.autopilot.events',
    fields: [
      { name: 'topic', type: 'string', default: 'autopilot.challenge.update' },
      { name: 'originator', type: 'string', default: 'auto_pilot' },
      { name: 'timestamp', type: 'string' },
      { name: 'mimeType', type: 'string', default: 'application/json' },
      {
        name: 'payload',
        type: {
          type: 'record',
          name: 'ChallengeUpdatePayload',
          fields: [
            { name: 'projectId', type: 'long' },
            { name: 'challengeId', type: 'string' }, // Changed from long to string for UUID
            { name: 'status', type: 'string' },
            { name: 'operator', type: 'string' },
            { name: 'date', type: 'string' },
            { name: 'phaseId', type: ['null', 'string'], default: null }, // Changed from long to string
            { name: 'phaseTypeName', type: ['null', 'string'], default: null },
          ],
        },
      },
    ],
  },
  [KAFKA_TOPICS.COMMAND]: {
    type: 'record',
    name: 'Command',
    namespace: 'com.autopilot.events',
    fields: [
      { name: 'topic', type: 'string', default: 'autopilot.command' },
      { name: 'originator', type: 'string', default: 'auto_pilot' },
      { name: 'timestamp', type: 'string' },
      { name: 'mimeType', type: 'string', default: 'application/json' },
      {
        name: 'payload',
        type: {
          type: 'record',
          name: 'CommandPayload',
          fields: [
            { name: 'command', type: 'string' },
            { name: 'operator', type: 'string' },
            { name: 'projectId', type: ['null', 'long'], default: null },
            { name: 'challengeId', type: ['null', 'string'], default: null },
            { name: 'date', type: ['null', 'string'], default: null },
            { name: 'phaseId', type: ['null', 'string'], default: null },
            { name: 'phaseTypeName', type: ['null', 'string'], default: null },
          ],
        },
      },
    ],
  },
};
