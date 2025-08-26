export interface IKafkaConfig {
  clientId: string;
  brokers: string[];
  retry: {
    initialRetryTime: number;
    retries: number;
    maxRetryTime: number;
  };
}
