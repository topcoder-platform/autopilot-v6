import appConfig from './sections/app.config';
import kafkaConfig from './sections/kafka.config';
import challengeConfig from './sections/challenge.config';

export default () => ({
  app: appConfig(),
  kafka: kafkaConfig(),
  challenge: challengeConfig(),
});
