import appConfig from './sections/app.config';
import kafkaConfig from './sections/kafka.config';
import challengeConfig from './sections/challenge.config';
import auth0Config from './sections/auth0.config';

export default () => ({
  app: appConfig(),
  kafka: kafkaConfig(),
  challenge: challengeConfig(),
  auth0: auth0Config(),
});
