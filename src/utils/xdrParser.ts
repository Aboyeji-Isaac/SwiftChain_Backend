import logger from '../config/logger';

export interface ParsedDelivery {
  type: 'delivery';
  deliveryId: string;
  recipient: string;
  amount: string;
  asset: string;
  timestamp: number;
}

export interface ParsedEscrow {
  type: 'escrow';
  escrowId: string;
  client: string;
  freelancer: string;
  amount: string;
  asset: string;
  releaseCondition: string;
  timestamp: number;
}

export type ParsedEvent = ParsedDelivery | ParsedEscrow;

export function parseXdrEvent(xdrPayload: string): ParsedEvent | null {
  try {
    if (!xdrPayload || xdrPayload.trim() === '') {
      return null;
    }

    // Validate base64
    if (!isValidXdr(xdrPayload)) {
      return null;
    }

    const decoded = decodeXdrPayload(xdrPayload);

    if (isDeliveryEvent(decoded)) {
      return parseDeliveryEvent(decoded);
    } else if (isEscrowEvent(decoded)) {
      return parseEscrowEvent(decoded);
    }

    return null;
  } catch (error) {
    logger.error('Failed to parse XDR payload:', error);
    return null;
  }
}

function decodeXdrPayload(xdrPayload: string): any {
  try {
    const buffer = Buffer.from(xdrPayload, 'base64');
    const decoded = JSON.parse(buffer.toString('utf8'));
    return decoded;
  } catch {
    // If not JSON, treat as raw data
    return { type: 'unknown', data: xdrPayload };
  }
}

function isDeliveryEvent(decoded: any): boolean {
  return decoded.type === 'delivery' && decoded.deliveryId;
}

function isEscrowEvent(decoded: any): boolean {
  return decoded.type === 'escrow' && decoded.escrowId;
}

function parseDeliveryEvent(decoded: any): ParsedDelivery {
  return {
    type: 'delivery',
    deliveryId: decoded.deliveryId || '',
    recipient: decoded.recipient || '',
    amount: decoded.amount || '0',
    asset: decoded.asset || 'XLM',
    timestamp: decoded.timestamp || Date.now(),
  };
}

function parseEscrowEvent(decoded: any): ParsedEscrow {
  return {
    type: 'escrow',
    escrowId: decoded.escrowId || '',
    client: decoded.client || '',
    freelancer: decoded.freelancer || '',
    amount: decoded.amount || '0',
    asset: decoded.asset || 'XLM',
    releaseCondition: decoded.releaseCondition || '',
    timestamp: decoded.timestamp || Date.now(),
  };
}

export function parseXdrEventSafe(xdrPayload: string): ParsedEvent | null {
  try {
    return parseXdrEvent(xdrPayload);
  } catch (error) {
    logger.error('Error parsing XDR (safe mode):', error);
    return null;
  }
}

// 🔥 FIXED: Now properly validates base64 strings - rejects spaces and invalid characters
export function isValidXdr(xdrPayload: string): boolean {
  try {
    if (!xdrPayload || xdrPayload.trim() === '') {
      return false;
    }

    // Remove whitespace and check if string is empty
    const trimmed = xdrPayload.trim();
    if (trimmed === '') {
      return false;
    }

    // 🔥 Check that the string only contains valid base64 characters (no spaces)
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(trimmed)) {
      return false;
    }

    // 🔥 Check that the string length is a multiple of 4 (base64 requirement)
    if (trimmed.length % 4 !== 0) {
      // Some base64 strings can be without padding, but we'll be strict
      // Allow length that's not multiple of 4 only if it has = padding
      if (!trimmed.includes('=') && trimmed.length % 4 !== 0) {
        return false;
      }
    }

    // Check if it's valid base64
    const buffer = Buffer.from(trimmed, 'base64');
    if (buffer.length === 0) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
