import { Module } from '@nestjs/common';
import { Auth0Service } from './auth0.service';

/** Shares the Keycloak token provider under the existing outbound-client DI contract. */
@Module({
  providers: [Auth0Service],
  exports: [Auth0Service],
})
export class Auth0Module {}
