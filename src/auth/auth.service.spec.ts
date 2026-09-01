import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('validates a real user stored in the database and issues a JWT', async () => {
    const userService = {
      findByEmailOrUsername: jest.fn().mockResolvedValue({
        _id: 'user-1',
        email: 'jane@example.com',
        username: 'jane',
        orgId: 'org-123',
        passwordHash: bcrypt.hashSync('myPassword123', 10),
      }),
    };

    const jwtService = {
      sign: jest.fn().mockReturnValue('signed-token'),
    };

    const service = new AuthService(userService as any, jwtService as any);

    const result = await service.login('jane@example.com', 'myPassword123');

    expect(userService.findByEmailOrUsername).toHaveBeenCalledWith(
      'jane@example.com',
    );
    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        userId: 'user-1',
        email: 'jane@example.com',
        username: 'jane',
        orgId: 'org-123',
      }),
      { expiresIn: '1d' },
    );

    expect(result.access_token).toBe('signed-token');
    expect(result.user.email).toBe('jane@example.com');
  });

  it('rejects empty credentials before checking the database', async () => {
    const service = new AuthService({} as any, { sign: jest.fn() } as any);

    await expect(service.login('', 'password')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.login('user@example.com', '')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('hashes and creates a new user for signup', async () => {
    const createdUser = {
      _id: 'user-2',
      email: 'newuser@example.com',
      username: 'newuser',
      orgId: 'org-123',
      passwordHash: 'hashed-password',
    };

    const userService = {
      findByEmailOrUsername: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdUser),
    };

    const jwtService = {
      sign: jest.fn().mockReturnValue('signup-token'),
    };

    const service = new AuthService(userService as any, jwtService as any);

    const result = await service.signup({
      email: 'newuser@example.com',
      username: 'newuser',
      password: 'Password123!',
      orgId: 'org-123',
    });

    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'newuser@example.com',
        username: 'newuser',
        orgId: 'org-123',
      }),
    );
    expect(result.access_token).toBe('signup-token');
    expect(result.user.email).toBe('newuser@example.com');
  });

  it('rejects signup when the email already exists', async () => {
    const userService = {
      findByEmailOrUsername: jest.fn().mockImplementation((value) => {
        if (value === 'john@example.com') {
          return Promise.resolve({
            _id: 'existing-user',
            email: 'john@example.com',
            username: 'john',
          });
        }
        return Promise.resolve(null);
      }),
      create: jest.fn(),
    };

    const service = new AuthService(
      userService as any,
      { sign: jest.fn() } as any,
    );

    await expect(
      service.signup({
        email: 'john@example.com',
        username: 'anotherjohn',
        password: 'Password123!',
      }),
    ).rejects.toThrow('Email already exists');

    expect(userService.create).not.toHaveBeenCalled();
  });

  it('rejects signup when the username already exists', async () => {
    const userService = {
      findByEmailOrUsername: jest.fn().mockImplementation((value) => {
        if (value === 'john') {
          return Promise.resolve({
            _id: 'existing-user',
            email: 'john@example.com',
            username: 'john',
          });
        }
        return Promise.resolve(null);
      }),
      create: jest.fn(),
    };

    const service = new AuthService(
      userService as any,
      { sign: jest.fn() } as any,
    );

    await expect(
      service.signup({
        email: 'another@example.com',
        username: 'john',
        password: 'Password123!',
      }),
    ).rejects.toThrow('Username already exists');

    expect(userService.create).not.toHaveBeenCalled();
  });
});
