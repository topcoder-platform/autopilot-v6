import { registerAs } from '@nestjs/config';

/** Exposes issuer metadata for environment-specific links; core reads the explicit KEYCLOAK_* settings. */
export default registerAs('keycloak', () => ({
  issuer: process.env.KEYCLOAK_ISSUER,
}));
