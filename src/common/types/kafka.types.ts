export interface IKafkaConfig {
  clientId: string;
  brokers: string[];
  connectionTimeout: number;
  requestTimeout: number;
  brokerTimeout: number;
  sessionTimeout: number;
  heartbeatInterval: number;
  maxWaitTime: number;
  retry: {
    initialRetryTime: number;
    retries: number;
    maxRetryTime: number;
  };
}
