import { registerAs } from '@nestjs/config';

/**
 * Exposes Keycloak issuer metadata for environment-specific links when USE_KEYCLOAK=true
 * (the Auth0 mode uses `auth0.domain`); core reads the explicit KEYCLOAK_* settings itself.
 */
export default registerAs('keycloak', () => ({
  issuer: process.env.KEYCLOAK_ISSUER,
}));
