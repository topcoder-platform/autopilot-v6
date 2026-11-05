import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import configuration from '../config/configuration';
import { AuthService } from './auth.service';

const secret = 'autopilot-test-signing-key-at-least-32-bytes';

describe('local JWT configuration', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, AUTH_SECRET: secret };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  /** Creates the issuer and verifier from the actual application configuration.
   * @returns A local authentication service; configuration/signing errors propagate.
   */
  function service(): AuthService {
    const settings = configuration();
    const config = new ConfigService({
      ...settings,
      LOCAL_AUTH_USERNAME: 'test-user',
      LOCAL_AUTH_PASSWORD: 'test-password-that-is-at-least-32-characters',
    });
    return new AuthService(
      new JwtService({
        secret: settings.jwt.secret,
        signOptions: { expiresIn: '1h' },
      }),
      config,
    );
  }

  it('signs and verifies a local token using the global AUTH_SECRET', async () => {
    const auth = service();
    const user = await auth.validateUser(
      'test-user',
      'test-password-that-is-at-least-32-characters',
    );
    expect(user).toEqual({ id: 1, username: 'test-user' });
    const { access_token } = await auth.login(user!);
    await expect(auth.verifyToken(access_token)).resolves.toEqual({
      sub: 1,
      username: 'test-user',
    });
  });

  it('rejects a local token signed with another key', async () => {
    const token = new JwtService({
      secret: 'another-signing-key-at-least-32-bytes',
    }).sign(
      { sub: '1', username: 'test-user' },
      { issuer: 'autopilot-v6', audience: 'autopilot-v6', expiresIn: '1h' },
    );
    await expect(service().verifyToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a local token intended for another audience', async () => {
    const token = new JwtService({ secret }).sign(
      { sub: '1', username: 'test-user' },
      { issuer: 'autopilot-v6', audience: 'other-api', expiresIn: '1h' },
    );
    await expect(service().verifyToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
