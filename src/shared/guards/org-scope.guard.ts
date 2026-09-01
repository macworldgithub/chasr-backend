// src/shared/guards/org-scope.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * OrgScopeGuard — ensures all API requests are strictly scoped to the user's organisation.
 *
 * Extracts `orgId` from the JWT and injects it into the request object.
 * This guarantees that controllers never rely on user-supplied org IDs from the request body.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { orgId?: string; user?: any }>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];

    try {
      // Secret must match the one used by Chasr's main API server
      const payload = this.jwtService.verify(token);

      if (!payload.orgId) {
        throw new UnauthorizedException('JWT is missing orgId claim');
      }

      // Inject into request for controllers to use
      request.orgId = payload.orgId;
      request.user = { id: payload.sub ?? payload.userId, ...payload };

      return true;
    } catch (err) {
      throw new UnauthorizedException('Invalid JWT');
    }
  }
}
