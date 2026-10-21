import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { auth, Principal } from 'tc-core-library-js';

/** Protects manual Kafka controls with shared identity validation and explicit service/member authorization. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly validator = auth.createValidator();

  /**
   * Validates the bearer credential and attaches its normalized principal to request.user.
   * @param context Nest request context for a manual Kafka control.
   * @returns True for write:autopilot services or administrator members.
   * @throws UnauthorizedException for invalid tokens; ForbiddenException for insufficient permissions.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string }; user?: Principal }>();
    const match =
      typeof request.headers.authorization === 'string'
        ? /^Bearer ([^\s]+)$/i.exec(request.headers.authorization)
        : null;
    let principal: Principal;
    try {
      if (!match) throw new Error('Missing token');
      principal = await this.validator.verify(match[1]);
    } catch {
      delete request.user;
      throw new UnauthorizedException('Invalid or expired token');
    }
    const allowed =
      principal.kind === 'service'
        ? auth.hasScopes(principal, ['write:autopilot'])
        : principal.roles.some(
            (role) => role.toLowerCase() === 'administrator',
          );
    if (!allowed) throw new ForbiddenException('Insufficient permissions');
    request.user = principal;
    return true;
  }
}
