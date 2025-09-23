import appConfig from './sections/app.config';
import kafkaConfig from './sections/kafka.config';
import challengeConfig from './sections/challenge.config';
import reviewConfig from './sections/review.config';
import resourcesConfig from './sections/resources.config';
import auth0Config from './sections/auth0.config';
import autopilotConfig from './sections/autopilot.config';

export default () => ({
  app: appConfig(),
  kafka: kafkaConfig(),
  challenge: challengeConfig(),
  review: reviewConfig(),
  resources: resourcesConfig(),
  auth0: auth0Config(),
  autopilot: autopilotConfig(),
});
