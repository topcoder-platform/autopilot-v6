import { registerAs } from '@nestjs/config';

export default registerAs('kafka', () => ({
  brokers: process.env.KAFKA_BROKERS || 'localhost:29092',
  clientId: process.env.KAFKA_CLIENT_ID || 'autopilot-service',
  connectionTimeout: Number(process.env.KAFKA_CONNECTION_TIMEOUT ?? 10000),
  requestTimeout: Number(process.env.KAFKA_REQUEST_TIMEOUT ?? 30000),
  brokerTimeout: Number(process.env.KAFKA_BROKER_TIMEOUT ?? 5000),
  sessionTimeout: Number(process.env.KAFKA_SESSION_TIMEOUT ?? 60000),
  heartbeatInterval: Number(process.env.KAFKA_HEARTBEAT_INTERVAL ?? 3000),
  maxWaitTime: Number(process.env.KAFKA_MAX_WAIT_TIME ?? 5000),
  retry: {
    maxRetryTime: parseInt(process.env.KAFKA_MAX_RETRY_TIME ?? '30000', 10),
    initialRetryTime: parseInt(
      process.env.KAFKA_INITIAL_RETRY_TIME ?? '300',
      10,
    ),
    retries: parseInt(process.env.KAFKA_RETRIES ?? '5', 10),
  },
}));
