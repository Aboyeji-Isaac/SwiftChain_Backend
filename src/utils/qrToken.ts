import crypto from 'crypto';

/**
 * Generates a secure, time-limited verification token for
 * delivery handoff QR codes.
 *
 * Token encodes: deliveryId + timestamp + HMAC signature
 * Expires after QR_TOKEN_EXPIRY_MINUTES (default: 30 minutes)
 *
 * @param deliveryId - MongoDB delivery document ID
 * @returns Signed verification token string
 */
export function generateQrToken(deliveryId: string): string {
  const secret = process.env.QR_TOKEN_SECRET ?? process.env.JWT_SECRET ?? '';

  if (!secret) {
    throw new Error('QR_TOKEN_SECRET environment variable is not set');
  }

  const expiryMinutes = parseInt(process.env.QR_TOKEN_EXPIRY_MINUTES ?? '30', 10);

  const expiresAt = Date.now() + expiryMinutes * 60 * 1000;
  const payload = `${deliveryId}:${expiresAt}`;

  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Base64url encode for URL-safety in QR data
  const token = Buffer.from(JSON.stringify({ deliveryId, expiresAt, signature })).toString(
    'base64url',
  );

  return token;
}

/**
 * Verifies and decodes a QR handoff token.
 *
 * @param token - Token string from QR code scan
 * @returns Decoded delivery ID if valid
 * @throws Error if token is invalid, tampered, or expired
 */
export function verifyQrToken(token: string): { deliveryId: string } {
  const secret = process.env.QR_TOKEN_SECRET ?? process.env.JWT_SECRET ?? '';

  let decoded: {
    deliveryId: string;
    expiresAt: number;
    signature: string;
  };

  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
  } catch {
    throw new Error('Invalid QR token format');
  }

  // Check expiry
  if (Date.now() > decoded.expiresAt) {
    throw new Error('QR token has expired');
  }

  // Verify HMAC signature
  const payload = `${decoded.deliveryId}:${decoded.expiresAt}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const sigBuffer = Buffer.from(decoded.signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid QR token signature');
  }

  return { deliveryId: decoded.deliveryId };
}
