# Keycloak migration branch

Pin shared core `4.0.0-keycloak.1` to immutable commit `e844764`.

## Provider switch: `USE_KEYCLOAK`

`USE_KEYCLOAK=true` makes this service get its M2M tokens from Keycloak, using
`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID` and
`KEYCLOAK_CLIENT_SECRET` (optional `KEYCLOAK_SCOPE` narrows the client's defaults).
`KEYCLOAK_ISSUER` is also required, and startup validation requires all five.
DEV uses issuer `https://keycloak.topcoder-dev.com/realms/topcoder-m2m-dev`, managed
endpoint `https://keycloak.topcoder-dev.com/m2m/token`, and audience
`https://api.topcoder-dev.com`.

Unset or `false` restores the Auth0 behaviour from before the migration: `Auth0Service`
posts the client-credentials grant straight to `AUTH0_URL` with `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET` and `AUTH0_AUDIENCE`, and caches the token until 60 seconds before
`expires_in`. Startup validation then requires `AUTH0_URL`, `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET`, `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` (defaults under
`NODE_ENV=test`); `AUTH0_PROXY_SEREVR_URL` stays optional and unused. `AUTH0_DOMAIN`
again picks the default review-app domain when `REVIEW_APP_URL` is unset (Keycloak mode
uses `KEYCLOAK_ISSUER`).

All outbound clients keep the `Auth0Service` DI name. `tc-core-library-js` reads the flag
(`auth.useKeycloak`) for the provider choice, the Joi validation and the flow runner, so
the service and the core always agree. Any value other than `true`/`false` fails at
startup. In DEV the flag is `/config/common/global-appvar/USE_KEYCLOAK`; the CircleCI
deploy already loads `/config/autopilot-v6/appvar` and `/config/common/global-appvar`.

Incoming machine tokens (manual `/kafka/*` controls): with `true`, Keycloak tokens are
accepted, plus Auth0 tokens while `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` are set.
With `false`, Auth0 tokens are accepted through `LEGACY_M2M_*`, plus Keycloak tokens
while `KEYCLOAK_ISSUER` and `KEYCLOAK_AUDIENCE` are set, so callers that have not
switched yet keep working.

**Rollback:** set `USE_KEYCLOAK=false` and force a new deployment so tasks re-read SSM.
No code or dependency change is needed. Keep the Auth0 settings above in SSM until
Keycloak has been accepted.

Manual `/kafka/*` controls now require a bearer token. Services need the explicit
`write:autopilot` scope; member callers need the administrator role. Health remains
public. Core owns signature, issuer, audience, lifetime and principal normalization;
member OAuth scopes never grant service access. Configure trusted member issuers
with `VALID_ISSUERS` and audiences with `AUTH_USER_AUDIENCES` JSON arrays. Existing
HMAC member support requires `AUTH_SECRET`; explicit `ALLOW_LEGACY_USER_AUDIENCE=true`
can retain legacy member audience behavior. `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE`
trust Auth0 machine tokens (see the provider switch above); a failed Keycloak issuance
never falls back to Auth0.

The unused demonstration admin/admin login and local JWT strategy were not mounted
in AppModule and are removed so they cannot become an alternate auth path. With
`USE_KEYCLOAK=true` the external developer flow runner requires explicit Keycloak
settings and refuses to overwrite an existing tester credential file; otherwise it writes
the `AUTH0_*`/`TC_M2M_*` credentials as before. Do not run flow tests against DEV
until receivers and workload grants are ready; they create real challenges.

Provision workload-specific credentials and downstream scope grants before rollout.
Manual control callers additionally need `write:autopilot` registered and granted.
Run `nvm use`, `pnpm lint`, `pnpm build`, `pnpm test --runInBand`, and
`pnpm test:keycloak`. No service, task definition or deployment tag is published
by this branch. Roll back with `USE_KEYCLOAK=false` (above); the service never retries a
failed Keycloak issuance with an Auth0 credential.

Validation: lint/build, all 261 unit tests and five compiled HTTP/auth boundary tests pass. Full E2E has 18 passing and eight failing tests; unchanged 1c7b7d79 with its original frozen dependencies reproduces the same eight failures (incomplete mocks and startup timeout). Live DEV issuance/cache and insufficient-control-scope denial pass. No live Kafka command was sent.

Validation on 23 October 2026 (USE_KEYCLOAK switch): lint/build, all 274 unit tests (including `auth0.service.spec.ts` and `validation.spec.ts`, which prove `false`/unset selects the pre-migration Auth0 request and settings and `true` the Keycloak provider) and the five compiled boundary tests pass. E2E: the same eight failures as the unchanged baseline c1b0d87.
