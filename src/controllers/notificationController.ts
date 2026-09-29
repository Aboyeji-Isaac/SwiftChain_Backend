import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import type { IUser } from '../interfaces/IUser';
import { NotificationEvent } from '../models/NotificationPreference';
import { notificationService } from '../services/notificationService';
import AppError from '../utils/AppError';

/**
 * NotificationController — HTTP surface for push notification preferences,
 * device registration and notification history.
 *
 * All routes operate on the authenticated user; none accept a user id from
 * the client, so one user can never read or mutate another's preferences.
 */

// ─── Validation schemas ────────────────────────────────────────────────────────

/** Body accepted by `PATCH /api/v1/notifications/preferences`. */
export const updatePreferencesSchema = z
  .object({
    pushEnabled: z.boolean().optional(),
    enabledEvents: z.array(z.nativeEnum(NotificationEvent)).optional(),
  })
  .refine((value) => value.pushEnabled !== undefined || value.enabledEvents !== undefined, {
    message: 'Provide at least one of "pushEnabled" or "enabledEvents"',
  });

/** Body accepted by `POST /api/v1/notifications/devices`. */
export const registerDeviceSchema = z.object({
  token: z.string().trim().min(1, 'Device token is required').max(4096),
  platform: z.enum(['ios', 'android', 'web']),
});

/** Body accepted by `DELETE /api/v1/notifications/devices`. */
export const unregisterDeviceSchema = z.object({
  token: z.string().trim().min(1, 'Device token is required').max(4096),
});

/** Query accepted by `GET /api/v1/notifications`. */
export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the authenticated user's id from the request.
 *
 * `authenticate` attaches the hydrated user document; this narrows it and
 * fails closed if the middleware was somehow bypassed.
 */
const requireUserId = (req: Request): string => {
  const user = (req as Request & { user?: IUser }).user;
  const id = user?._id ? String(user._id) : undefined;

  if (!id) {
    throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
  }
  return id;
};

// ─── GET /api/v1/notifications/preferences ─────────────────────────────────────

/**
 * Return the authenticated user's notification preferences.
 *
 * Defaults are created on first access, so this never 404s for a valid user.
 */
export const getPreferences = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const preference = await notificationService.getPreferences(requireUserId(req));

    res.status(StatusCodes.OK).json({
      status: 'success',
      data: {
        pushEnabled: preference.pushEnabled,
        enabledEvents: preference.enabledEvents,
        deviceCount: preference.devices.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/notifications/preferences ───────────────────────────────────

/**
 * Update the authenticated user's notification preferences.
 *
 * Both fields are optional; `validateRequest` rejects an empty body.
 */
export const updatePreferences = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof updatePreferencesSchema>;
    const preference = await notificationService.updatePreferences(requireUserId(req), body);

    res.status(StatusCodes.OK).json({
      status: 'success',
      message: 'Notification preferences updated',
      data: {
        pushEnabled: preference.pushEnabled,
        enabledEvents: preference.enabledEvents,
        deviceCount: preference.devices.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── POST /api/v1/notifications/devices ────────────────────────────────────────

/**
 * Register (or refresh) a push token for one of the user's devices.
 *
 * Registering a token already held by another account detaches it from that
 * account first — see NotificationPreferenceRepository#registerDevice.
 */
export const registerDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof registerDeviceSchema>;
    const preference = await notificationService.registerDevice({
      userId: requireUserId(req),
      token: body.token,
      platform: body.platform,
    });

    res.status(StatusCodes.CREATED).json({
      status: 'success',
      message: 'Device registered for push notifications',
      data: { deviceCount: preference.devices.length },
    });
  } catch (error) {
    next(error);
  }
};

// ─── DELETE /api/v1/notifications/devices ──────────────────────────────────────

/** Remove a device push token, e.g. on logout. */
export const unregisterDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = req.body as z.infer<typeof unregisterDeviceSchema>;
    const preference = await notificationService.unregisterDevice(requireUserId(req), body.token);

    res.status(StatusCodes.OK).json({
      status: 'success',
      message: 'Device unregistered',
      data: { deviceCount: preference.devices.length },
    });
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/notifications ─────────────────────────────────────────────────

/** Return a page of the authenticated user's notification history. */
export const listNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { page, limit } = req.query as unknown as z.infer<typeof listNotificationsSchema>;
    const result = await notificationService.listForUser(requireUserId(req), page, limit);

    res.status(StatusCodes.OK).json({
      status: 'success',
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};
