import { registerAs } from '@nestjs/config';

/**
 * Exposes the pre-migration Auth0 M2M settings as the `auth0` config section.
 * Read by `Auth0Service` (token URL, credentials, audience) and the phase-change
 * notification domain fallback, but only when `USE_KEYCLOAK` is unset or `false`;
 * Keycloak mode reads the `KEYCLOAK_*` settings instead. Takes no parameters and never throws.
 */
export default registerAs('auth0', () => ({
  url: process.env.AUTH0_URL,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  domain: process.env.AUTH0_DOMAIN,
  audience: process.env.AUTH0_AUDIENCE,
  proxyServerUrl: process.env.AUTH0_PROXY_SEREVR_URL,
}));
