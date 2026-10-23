import { validationSchema } from './validation';

const base = {
  NODE_ENV: 'production',
  KAFKA_BROKERS: 'localhost:9092',
  CHALLENGE_DB_URL: 'postgresql://localhost:5432/challenge',
  REVIEW_DB_URL: 'postgresql://localhost:5432/review',
  RESOURCES_DB_URL: 'postgresql://localhost:5432/resources',
  MEMBER_DB_URL: 'postgresql://localhost:5432/members',
  BUS_API_URL: 'https://api.example/v6/bus',
};
const keycloak = {
  KEYCLOAK_ISSUER: 'https://keycloak.example/realms/m2m',
  KEYCLOAK_TOKEN_URL: 'https://keycloak.example/m2m/token',
  KEYCLOAK_AUDIENCE: 'https://api.example',
  KEYCLOAK_CLIENT_ID: 'm2m-autopilot',
  KEYCLOAK_CLIENT_SECRET: 'keycloak-secret',
};
const auth0 = {
  AUTH0_URL: 'https://tenant.example/oauth/token',
  AUTH0_CLIENT_ID: 'auth0-autopilot',
  AUTH0_CLIENT_SECRET: 'auth0-secret',
  AUTH0_DOMAIN: 'tenant.example',
  AUTH0_AUDIENCE: 'https://m2m.example/',
};

/**
 * Validate an environment the way ConfigModule does; returns the error message or
 * undefined. The decision uses the validated USE_KEYCLOAK value, not the test setup's
 * process.env.USE_KEYCLOAK=true.
 */
function check(env: Record<string, string | undefined>): string | undefined {
  return validationSchema.validate(env, {
    abortEarly: false,
    allowUnknown: true,
  }).error?.message;
}

describe('validationSchema USE_KEYCLOAK provider settings', () => {
  it('requires the KEYCLOAK_* settings, not AUTH0_*, when USE_KEYCLOAK=true', () => {
    expect(
      check({ ...base, ...keycloak, USE_KEYCLOAK: 'true' }),
    ).toBeUndefined();
    expect(
      check({ ...base, ...keycloak, USE_KEYCLOAK: ' TRUE ' }),
    ).toBeUndefined();
    expect(check({ ...base, ...auth0, USE_KEYCLOAK: 'true' })).toContain(
      '"KEYCLOAK_ISSUER" is required',
    );
    expect(
      check({
        ...base,
        ...keycloak,
        KEYCLOAK_TOKEN_URL: 'http://keycloak.example/m2m/token',
        USE_KEYCLOAK: 'true',
      }),
    ).toContain('KEYCLOAK_TOKEN_URL');
  });

  it.each([['false'], [''], [undefined]])(
    'requires the pre-migration AUTH0_* settings, not KEYCLOAK_*, when USE_KEYCLOAK=%p',
    (value) => {
      expect(check({ ...base, ...auth0, USE_KEYCLOAK: value })).toBeUndefined();
      const message = check({ ...base, ...keycloak, USE_KEYCLOAK: value });
      for (const name of Object.keys(auth0)) {
        expect(message).toContain(`"${name}" is required`);
      }
      expect(message).not.toContain('KEYCLOAK');
    },
  );

  it('keeps the Auth0 test defaults under NODE_ENV=test', () => {
    const { error, value } = validationSchema.validate(
      { ...base, NODE_ENV: 'test', USE_KEYCLOAK: 'false' },
      { allowUnknown: true },
    );
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      AUTH0_URL: 'https://test.auth0.com/oauth/token',
      AUTH0_CLIENT_ID: 'test-client-id',
      AUTH0_AUDIENCE: 'https://test-api.topcoder.com',
    });
  });

  it('rejects an invalid USE_KEYCLOAK value', () => {
    expect(
      check({ ...base, ...auth0, ...keycloak, USE_KEYCLOAK: 'yes' }),
    ).toContain('USE_KEYCLOAK must be true or false');
  });
});
