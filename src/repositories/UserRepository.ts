import User from '../models/User';
import { IUser, UserRole, UserStatus } from '../interfaces/IUser';
import { BaseRepository } from './BaseRepository';
import { ReadOptions, WriteOptions } from './types';

/**
 * Persistence gateway for the `User` collection.
 *
 * The `password` field is `select: false` on the schema, so it is absent from
 * every read unless {@link findByEmailWithPassword} is used. Keeping that the
 * single opt-in point means a hash cannot leak into an API response by accident.
 */
export class UserRepository extends BaseRepository<IUser> {
  constructor() {
    super(User);
  }

  /** Find a user by email. The password hash is **not** included. */
  async findByEmail(email: string, options?: ReadOptions<IUser>): Promise<IUser | null> {
    return this.findOne({ email: email.toLowerCase().trim() }, options);
  }

  /**
   * Find a user by email **including** the password hash.
   *
   * Intended solely for credential verification during login.
   */
  async findByEmailWithPassword(email: string): Promise<IUser | null> {
    return this.findOne({ email: email.toLowerCase().trim() }, { projection: '+password' });
  }

  /** Find a user by their Stellar public key. */
  async findByWalletAddress(walletAddress: string): Promise<IUser | null> {
    return this.findOne({ walletAddress });
  }

  /** Whether an account already exists for this email. */
  async emailExists(email: string): Promise<boolean> {
    return this.exists({ email: email.toLowerCase().trim() });
  }

  /** Resolve several users by id in one query, skipping malformed ids. */
  async findByIds(ids: string[], options?: ReadOptions<IUser>): Promise<IUser[]> {
    const valid = ids.filter((id) => this.isValidId(id));
    if (valid.length === 0) return [];
    return this.find({ _id: { $in: valid } }, options);
  }

  /** All users holding a given role — used for administrative fan-out. */
  async findByRole(role: UserRole, options?: ReadOptions<IUser>): Promise<IUser[]> {
    return this.find({ role }, options);
  }

  /** Suspend an account, recording the reason and the time it took effect. */
  async suspend(id: string, reason: string, options?: WriteOptions): Promise<IUser | null> {
    return this.updateById(
      id,
      {
        $set: {
          status: UserStatus.SUSPENDED,
          suspendedReason: reason,
          suspendedAt: new Date(),
          isActive: false,
        },
      },
      options,
    );
  }

  /** Reactivate a suspended account and clear the suspension metadata. */
  async reactivate(id: string, options?: WriteOptions): Promise<IUser | null> {
    return this.updateById(
      id,
      {
        $set: { status: UserStatus.ACTIVE, isActive: true },
        $unset: { suspendedReason: '', suspendedAt: '' },
      },
      options,
    );
  }
}

export const userRepository = new UserRepository();
