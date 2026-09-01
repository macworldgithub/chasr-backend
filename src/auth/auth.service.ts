import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../users/user.service';
import { SignupDto } from './dto/signup.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async signup(dto: SignupDto) {
    const email = dto.email?.trim().toLowerCase();
    const username = dto.username?.trim();
    const password = dto.password?.trim();

    if (!email || !username || !password) {
      throw new UnauthorizedException(
        'Email, username, and password are required',
      );
    }

    const existingEmailUser = await this.userService.findByEmailOrUsername(email);
    if (existingEmailUser) {
      throw new ConflictException('Email already exists');
    }

    const existingUsernameUser =
      await this.userService.findByEmailOrUsername(username);
    if (existingUsernameUser) {
      throw new ConflictException('Username already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let user;
    try {
      user = await this.userService.create({
        email,
        username,
        passwordHash,
        orgId: dto.orgId || process.env.DEFAULT_ORG_ID || 'default-org',
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new ConflictException(
          'A user with this email or username already exists',
        );
      }
      throw error;
    }

    const payload = {
      sub: user._id.toString(),
      userId: user._id.toString(),
      orgId: user.orgId,
      email: user.email,
      username: user.username,
    };

    const token = this.jwtService.sign(payload, { expiresIn: '1d' });

    return {
      access_token: token,
      user: {
        id: payload.sub,
        orgId: payload.orgId,
        email: payload.email,
        username: payload.username,
      },
    };
  }

  async login(username: string, password: string) {
    const normalizedUsername = username?.trim();
    const normalizedPassword = password?.trim();

    if (!normalizedUsername || !normalizedPassword) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const user =
      await this.userService.findByEmailOrUsername(normalizedUsername);
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatches = await bcrypt.compare(
      normalizedPassword,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const payload = {
      sub: user._id.toString(),
      userId: user._id.toString(),
      orgId: user.orgId,
      email: user.email,
      username: user.username,
    };

    const token = this.jwtService.sign(payload, { expiresIn: '1d' });

    return {
      access_token: token,
      user: {
        id: payload.sub,
        orgId: payload.orgId,
        email: payload.email,
        username: payload.username,
      },
    };
  }
}
