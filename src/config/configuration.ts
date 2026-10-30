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
import memberApiConfig from './sections/member-api.config';
import marathonMatchConfig from './sections/marathon-match.config';

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
  memberApi: memberApiConfig(),
  marathonMatch: marathonMatchConfig(),
  // The local token issuer and shared verifier must use the same configured key.
  jwt: {
    secret: process.env.AUTH_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  },
});
