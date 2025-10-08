import appConfig from './sections/app.config';
import kafkaConfig from './sections/kafka.config';
import challengeConfig from './sections/challenge.config';
import reviewConfig from './sections/review.config';
import resourcesConfig from './sections/resources.config';
import membersConfig from './sections/members.config';
import busConfig from './sections/bus.config';
import auth0Config from './sections/auth0.config';
import autopilotConfig from './sections/autopilot.config';
import financeConfig from './sections/finance.config';

export default () => ({
  app: appConfig(),
  kafka: kafkaConfig(),
  challenge: challengeConfig(),
  review: reviewConfig(),
  resources: resourcesConfig(),
  members: membersConfig(),
  bus: busConfig(),
  auth0: auth0Config(),
  autopilot: autopilotConfig(),
  finance: financeConfig(),
});
