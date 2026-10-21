import { Injectable } from '@nestjs/common';
import { auth } from 'tc-core-library-js';

/**
 * Keycloak-only outbound token provider. The legacy DI class name is retained for
 * existing API clients; shared core owns signature validation, expiry and caching.
 */
@Injectable()
export class Auth0Service {
  private readonly m2m: ReturnType<typeof auth.m2m>;

  /** Initializes one core factory; takes no arguments; invalid Keycloak configuration throws. */
  constructor() {
    this.m2m = auth.m2m();
  }

  /** Takes no arguments; returns a verified workload token; sanitized issuance/configuration errors propagate. */
  getAccessToken(): Promise<string> {
    return this.m2m.getMachineToken();
  }

  /** Clears the local verified-token cache after an upstream 401; no arguments/return value; does not throw. */
  clearTokenCache(): void {
    this.m2m.clearCache();
  }
}
