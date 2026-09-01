import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './user.schema';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async findByEmailOrUsername(
    identifier: string,
  ): Promise<UserDocument | null> {
    const normalized = identifier?.trim();
    if (!normalized) {
      return null;
    }

    return this.userModel
      .findOne({
        $or: [{ email: normalized.toLowerCase() }, { username: normalized }],
      })
      .exec();
  }

  async create(data: Partial<User>): Promise<UserDocument> {
    return this.userModel.create({
      email: data.email?.trim().toLowerCase(),
      username: data.username?.trim(),
      passwordHash: data.passwordHash,
      orgId: data.orgId || 'default-org',
    });
  }
}
