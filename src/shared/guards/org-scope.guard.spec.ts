import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { OrgScopeGuard } from './org-scope.guard';

describe('OrgScopeGuard', () => {
  it('should construct with jwt and reflector dependencies', () => {
    const jwtService = { verify: jest.fn() } as unknown as JwtService;
    const reflector = new Reflector();

    const guard = new OrgScopeGuard(jwtService, reflector);

    expect(guard).toBeInstanceOf(OrgScopeGuard);
  });
});
