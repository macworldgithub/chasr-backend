import { Types } from 'mongoose';

export function normalizeOrgId(orgId: string): string | Types.ObjectId {
  return Types.ObjectId.isValid(orgId) ? new Types.ObjectId(orgId) : orgId;
}
