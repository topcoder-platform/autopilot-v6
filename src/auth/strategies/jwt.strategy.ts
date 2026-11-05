import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { IValidatedUser } from '../../common/types/auth.types';

/** Adapts the shared verifier to Passport's jwt guard used by autopilot routes. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  /** Injects the shared auth adapter; returns a strategy and performs no I/O. */
  constructor(private readonly authService: AuthService) {
    super();
  }

  /** Verifies the request header and returns an autopilot identity; throws UnauthorizedException for invalid tokens. */
  async validate(request: Request): Promise<IValidatedUser> {
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('A bearer token is required');
    const payload = await this.authService.verifyToken(match[1]);
    if (!payload.sub || !payload.username)
      throw new UnauthorizedException('Invalid token identity');
    return { id: payload.sub, username: payload.username };
  }
}
