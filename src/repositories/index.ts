/**
 * Repository layer.
 *
 * Every database access in the application goes through one of these classes.
 * Services depend on repositories; only repositories import Mongoose models.
 *
 * Each repository is exported both as a class (for tests that want an isolated
 * instance) and as a shared singleton (used by services at runtime).
 */
export { BaseRepository } from './BaseRepository';
export type { IRepository, Page, ReadOptions, WriteOptions } from './types';

export { DeliveryRepository, deliveryRepository } from './DeliveryRepository';
export type { DeliveryQueryFilter } from './DeliveryRepository';

export { UserRepository, userRepository } from './UserRepository';
export { EscrowRepository, escrowRepository } from './EscrowRepository';

export {
  NotificationPreferenceRepository,
  notificationPreferenceRepository,
} from './NotificationPreferenceRepository';
export { NotificationRepository, notificationRepository } from './NotificationRepository';
export { ChatMessageRepository, chatMessageRepository } from './ChatMessageRepository';
