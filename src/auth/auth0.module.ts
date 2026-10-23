import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { Auth0Service } from './auth0.service';

/**
 * Shares the outbound M2M token provider under the existing outbound-client DI contract.
 * `USE_KEYCLOAK` selects Keycloak or Auth0 inside `Auth0Service`; HttpModule serves the
 * Auth0 token request.
 */
@Module({
  imports: [HttpModule],
  providers: [Auth0Service],
  exports: [Auth0Service],
})
export class Auth0Module {}
