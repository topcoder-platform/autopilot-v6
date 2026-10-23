import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { auth } from 'tc-core-library-js';
import { Auth0Service } from './auth0.service';

const auth0Settings: Record<string, string> = {
  'auth0.url': 'https://tenant.example/oauth/token',
  'auth0.clientId': 'auth0-autopilot',
  'auth0.clientSecret': 'auth0-secret',
  'auth0.audience': 'https://m2m.example/',
};

describe('Auth0Service USE_KEYCLOAK provider selection', () => {
  const saved = process.env.USE_KEYCLOAK;
  let httpService: { post: jest.Mock };
  let configService: { get: jest.Mock };
  let provider: { getMachineToken: jest.Mock; clearCache: jest.Mock };
  let m2m: jest.SpyInstance;

  /** Build the service with mocked HTTP/config dependencies. */
  const create = () =>
    new Auth0Service(
      httpService as unknown as HttpService,
      configService as unknown as ConfigService,
    );

  beforeEach(() => {
    httpService = {
      post: jest.fn(() =>
        of({
          data: {
            access_token: 'auth0-token',
            token_type: 'Bearer',
            expires_in: 3600,
          },
        }),
      ),
    };
    configService = { get: jest.fn((key: string) => auth0Settings[key]) };
    provider = {
      getMachineToken: jest.fn().mockResolvedValue('keycloak-token'),
      clearCache: jest.fn(),
    };
    m2m = jest
      .spyOn(auth, 'm2m')
      .mockReturnValue(provider as unknown as ReturnType<typeof auth.m2m>);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.USE_KEYCLOAK;
    else process.env.USE_KEYCLOAK = saved;
    jest.restoreAllMocks();
  });

  it.each([['false'], [''], [undefined]])(
    'posts the pre-migration Auth0 request when USE_KEYCLOAK=%p',
    async (value) => {
      if (value === undefined) delete process.env.USE_KEYCLOAK;
      else process.env.USE_KEYCLOAK = value;
      const service = create();

      await expect(service.getAccessToken()).resolves.toBe('auth0-token');
      await expect(service.getAccessToken()).resolves.toBe('auth0-token');

      expect(m2m).not.toHaveBeenCalled();
      expect(httpService.post).toHaveBeenCalledTimes(1);
      expect(httpService.post).toHaveBeenCalledWith(
        'https://tenant.example/oauth/token',
        {
          client_id: 'auth0-autopilot',
          client_secret: 'auth0-secret',
          audience: 'https://m2m.example/',
          grant_type: 'client_credentials',
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
      );

      service.clearTokenCache();
      await service.getAccessToken();
      expect(httpService.post).toHaveBeenCalledTimes(2);
    },
  );

  it('uses the core Keycloak provider and its KEYCLOAK_* defaults when USE_KEYCLOAK=true', async () => {
    process.env.USE_KEYCLOAK = 'true';
    const service = create();

    await expect(service.getAccessToken()).resolves.toBe('keycloak-token');
    service.clearTokenCache();

    expect(m2m).toHaveBeenCalledWith();
    expect(provider.getMachineToken).toHaveBeenCalledWith();
    expect(provider.clearCache).toHaveBeenCalledTimes(1);
    expect(configService.get).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('rejects an invalid USE_KEYCLOAK value at construction', () => {
    process.env.USE_KEYCLOAK = 'yes';
    expect(create).toThrow(TypeError);
  });
});
