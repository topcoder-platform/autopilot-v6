export const KAFKA_TOPICS = {
  PHASE_TRANSITION: 'autopilot.phase.transition',
  CHALLENGE_UPDATE: 'autopilot.challenge.update',
  CHALLENGE_CREATED: 'challenge.notification.create',
  CHALLENGE_UPDATED: 'challenge.notification.update',
  COMMAND: 'autopilot.command',
  SUBMISSION_NOTIFICATION_AGGREGATE: 'submission.notification.aggregate',
  RESOURCE_CREATED: 'challenge.action.resource.create',
  RESOURCE_DELETED: 'challenge.action.resource.delete',
  REVIEW_COMPLETED: 'review.action.completed',
  REVIEW_APPEAL_RESPONDED: 'review.action.appeal.responded',
  FIRST2FINISH_SUBMISSION_RECEIVED: 'first2finish.submission.received',
  TOPGEAR_SUBMISSION_RECEIVED: 'topgear.submission.received',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];
