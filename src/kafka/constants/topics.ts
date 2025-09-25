export const KAFKA_TOPICS = {
  PHASE_TRANSITION: 'autopilot.phase.transition',
  CHALLENGE_UPDATE: 'autopilot.challenge.update',
  CHALLENGE_CREATED: 'challenge.notification.create',
  CHALLENGE_UPDATED: 'challenge.notification.update',
  COMMAND: 'autopilot.command',
  SUBMISSION_NOTIFICATION_AGGREGATE: 'submission.notification.aggregate',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];
