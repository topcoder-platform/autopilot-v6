import { BaseException } from './base.exception';

export class KafkaException extends BaseException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'KAFKA_ERROR', 500, details);
  }
}

export class KafkaConnectionException extends KafkaException {
  constructor(details?: Record<string, unknown>) {
    super('Failed to connect to Kafka broker', details);
  }
}

export class KafkaProducerException extends KafkaException {
  constructor(topic: string, details?: Record<string, unknown>) {
    super(`Failed to produce message to topic ${topic}`, details);
  }
}

export class KafkaConsumerException extends KafkaException {
  constructor(groupId: string, details?: Record<string, unknown>) {
    super(`Failed to start consumer ${groupId}`, details);
  }
}
