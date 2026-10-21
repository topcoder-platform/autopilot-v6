# Keycloak migration branch

Pin shared core `4.0.0-keycloak.0` to immutable commit `c262f4a`. Set
`M2M_PROVIDER=keycloak`, `KEYCLOAK_ISSUER`, `KEYCLOAK_TOKEN_URL`,
`KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, and `KEYCLOAK_CLIENT_SECRET` explicitly.
DEV uses issuer `https://keycloak.topcoder-dev.com/realms/topcoder-m2m-dev`, managed
endpoint `https://keycloak.topcoder-dev.com/m2m/token`, and audience
`https://api.topcoder-dev.com`. Optional `KEYCLOAK_SCOPE` narrows approved defaults.
All outbound clients retain the Auth0Service DI name for compatibility but obtain
only verified Keycloak tokens from one shared-core cache per provider instance.

Manual `/kafka/*` controls now require a bearer token. Services need the explicit
`write:autopilot` scope; member callers need the administrator role. Health remains
public. Core owns signature, issuer, audience, lifetime and principal normalization;
member OAuth scopes never grant service access. Configure trusted member issuers
with `VALID_ISSUERS` and audiences with `AUTH_USER_AUDIENCES` JSON arrays. Existing
HMAC member support requires `AUTH_SECRET`; explicit `ALLOW_LEGACY_USER_AUDIENCE=true`
can retain legacy member audience behavior. A deliberate validation overlap uses
`LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE`; issuance never falls back to Auth0.

The unused demonstration admin/admin login and local JWT strategy were not mounted
in AppModule and are removed so they cannot become an alternate auth path. The
external developer flow runner now requires explicit Keycloak settings and refuses
to overwrite an existing tester credential file. Do not run flow tests against DEV
until receivers and workload grants are ready; they create real challenges.

Provision workload-specific credentials and downstream scope grants before rollout.
Manual control callers additionally need `write:autopilot` registered and granted.
Run `nvm use`, `pnpm lint`, `pnpm build`, `pnpm test --runInBand`, and
`pnpm test:keycloak`. No service, task definition or deployment tag is published
by this branch. Roll back application/core/configuration together, never retry
failed issuance with an Auth0 credential.

Validation: lint/build, all 261 unit tests and five compiled HTTP/auth boundary tests pass. Full E2E has 18 passing and eight failing tests; unchanged 1c7b7d79 with its original frozen dependencies reproduces the same eight failures (incomplete mocks and startup timeout). Live DEV issuance/cache and insufficient-control-scope denial pass. No live Kafka command was sent.
