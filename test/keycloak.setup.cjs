Object.assign(process.env,{M2M_PROVIDER:'keycloak',KEYCLOAK_ISSUER:'https://keycloak.example.test/realms/test',
  KEYCLOAK_TOKEN_URL:'https://keycloak.example.test/m2m/token',KEYCLOAK_AUDIENCE:'https://api.example.test',
  KEYCLOAK_CLIENT_ID:'test-client',KEYCLOAK_CLIENT_SECRET:'synthetic-secret',
  VALID_ISSUERS:'["https://members.example.test"]',AUTH_SECRET:'synthetic-member-key',ALLOW_LEGACY_USER_AUDIENCE:'true'});
