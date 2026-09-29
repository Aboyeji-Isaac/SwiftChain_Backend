/**
 * Provider-agnostic push transport contract.
 *
 * The notification service depends only on this interface, so swapping FCM for
 * OneSignal (or adding a second provider) is a configuration change rather
 * than a rewrite of the business logic.
 */

/** A push message targeted at one or more device tokens. */
export interface PushMessage {
  tokens: string[];
  title: string;
  body: string;
  /**
   * Key/value payload delivered alongside the notification.
   *
   * FCM requires every data value to be a string, so the type is narrowed here
   * rather than at the call site.
   */
  data: Record<string, string>;
}

/** Outcome of a single push send, aggregated across the target tokens. */
export interface PushResult {
  acceptedCount: number;
  rejectedCount: number;
  /**
   * Tokens the provider reported as permanently invalid (unregistered or
   * malformed). These are pruned from the database by the caller.
   */
  invalidTokens: string[];
  /** Present when the send failed outright rather than per-token. */
  failureReason?: string;
}

export interface IPushProvider {
  /** Human-readable provider name, used in logs and health output. */
  readonly name: string;
  /**
   * Whether the provider holds the credentials it needs to send.
   *
   * The service checks this before attempting a send so an unconfigured
   * environment records an explicit skip instead of a misleading failure.
   */
  isConfigured(): boolean;
  send(message: PushMessage): Promise<PushResult>;
}
