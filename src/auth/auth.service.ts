import { verifySignedJwt } from 'tc-core-library-js';
import { timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

interface User {
  id: number;
  username: string;
}

interface JwtPayload {
  username: string;
  sub: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /** Checks explicitly configured local credentials; returns a local user or null and never enables default credentials. */
  validateUser(username: string, password: string): Promise<User | null> {
    const expectedUser = this.configService.get<string>('LOCAL_AUTH_USERNAME');
    const expectedPassword = this.configService.get<string>(
      'LOCAL_AUTH_PASSWORD',
    );
    if (!expectedUser || !expectedPassword || expectedPassword.length < 32)
      return Promise.resolve(null);
    const candidate = Buffer.from(password);
    const expected = Buffer.from(expectedPassword);
    const matches =
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected);
    return Promise.resolve(
      username === expectedUser && matches ? { id: 1, username } : null,
    );
  }

  /** Issues an audience- and issuer-bound token for the supplied local user; returns the token or rejects on signing failure. */
  login(user: User): Promise<{ access_token: string }> {
    const payload: JwtPayload = { username: user.username, sub: user.id };
    return Promise.resolve({
      access_token: this.jwtService.sign(
        { ...payload, sub: String(payload.sub) },
        {
          issuer: 'autopilot-v6',
          audience: 'autopilot-v6',
        },
      ),
    });
  }

  /** Verifies the supplied token through tc-core; returns local identity or throws UnauthorizedException. */
  verifyToken(token: string): Promise<JwtPayload> {
    try {
      // Local operators authenticate with configured credentials, not member email.
      // Keep these tokens bound to Autopilot; member/Auth0 tokens are never accepted.
      const secret = this.configService.get<string>('jwt.secret');
      if (
        !secret ||
        Buffer.byteLength(secret) < 32 ||
        secret.includes('-----BEGIN')
      )
        throw new Error('Invalid signing configuration');
      const payload = verifySignedJwt(token, secret, {
        issuer: 'autopilot-v6',
        audience: 'autopilot-v6',
        algorithms: ['HS256'],
      });
      if (
        typeof payload.username !== 'string' ||
        !Number.isSafeInteger(Number(payload.sub))
      )
        throw new Error('Invalid identity');
      return Promise.resolve({
        sub: Number(payload.sub),
        username: payload.username,
      });
    } catch {
      return Promise.reject(new UnauthorizedException('Invalid token'));
    }
  }
}
