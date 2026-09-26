/**
 * Unit tests for the PII masking helpers used by the logging interface.
 */

import { maskString, maskValue, isSensitiveKey, REDACTED } from '../src/utils/piiMasker';

describe('maskString', () => {
  it('masks an email but keeps the domain for correlation', () => {
    expect(maskString('login failed for alice@example.com')).toBe(
      'login failed for al***@example.com',
    );
  });

  it('masks every email in a string', () => {
    const masked = maskString('from a@x.com to bob@y.org');
    expect(masked).not.toContain('a@x.com');
    expect(masked).not.toContain('bob@y.org');
    expect(masked).toContain('@x.com');
    expect(masked).toContain('@y.org');
  });

  it('redacts a JWT entirely', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const masked = maskString(`token=${jwt}`);

    expect(masked).toBe(`token=${REDACTED}`);
    expect(masked).not.toContain('eyJ');
  });

  it('redacts the credential in a bearer header but keeps the scheme', () => {
    const masked = maskString('Authorization: Bearer abcdef1234567890');
    expect(masked).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('redacts a Stellar secret seed in full', () => {
    const secret = `S${'A'.repeat(55)}`;
    expect(maskString(`seed ${secret}`)).toBe(`seed ${REDACTED}`);
  });

  it('partially masks a Stellar public key, which is not a secret', () => {
    const publicKey = `G${'A'.repeat(55)}`;
    const masked = maskString(`payer ${publicKey}`);

    expect(masked).not.toBe(`payer ${publicKey}`);
    expect(masked).toContain('GAAA');
    expect(masked).toContain('***');
  });

  it('strips the password out of a connection string', () => {
    const masked = maskString('mongodb://appuser:sup3rs3cret@cluster0.mongodb.net/db');

    expect(masked).not.toContain('sup3rs3cret');
    expect(masked).toContain('appuser');
    expect(masked).toContain('cluster0.mongodb.net');
  });

  it('keeps only the last four digits of a valid card number', () => {
    // Luhn-valid test number.
    const masked = maskString('card 4242424242424242 charged');
    expect(masked).toBe('card ****-****-****-4242 charged');
  });

  it('leaves long non-card numbers such as ledger sequences intact', () => {
    // Not Luhn-valid, so it must not be treated as a card.
    expect(maskString('ledger 1234567890123456')).toBe('ledger 1234567890123456');
  });

  it('masks the middle of a phone number', () => {
    const masked = maskString('call +14155552671 now');

    expect(masked).not.toContain('+14155552671');
    expect(masked).toContain('+14');
    expect(masked).toContain('71');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(maskString(`key: ${pem}`)).toBe(`key: ${REDACTED}`);
  });

  it('returns empty and non-PII strings unchanged', () => {
    expect(maskString('')).toBe('');
    expect(maskString('delivery created successfully')).toBe('delivery created successfully');
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'Password',
    'passphrase',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'api_key',
    'privateKey',
    'authorization',
    'cookie',
    'secret',
    'clientSecret',
    'mnemonic',
    'cvv',
    'ssn',
    'signedXdr',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['tokenType', 'authProvider', 'hasToken', 'tokenExpiresAt'])(
    'allows the non-secret key %s through',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it.each(['deliveryId', 'status', 'amount', 'createdAt'])(
    'treats ordinary key %s as safe',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('maskValue', () => {
  it('redacts sensitive keys wholesale regardless of their value', () => {
    const masked = maskValue({ email: 'bob@example.com', password: 'hunter2' }) as Record<
      string,
      unknown
    >;

    expect(masked.password).toBe(REDACTED);
    expect(masked.email).toBe('bo***@example.com');
  });

  it('walks nested objects', () => {
    const masked = maskValue({
      user: { profile: { email: 'deep@example.com', apiKey: 'k-123' } },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(masked.user.profile.email).toBe('de***@example.com');
    expect(masked.user.profile.apiKey).toBe(REDACTED);
  });

  it('walks arrays of objects', () => {
    const masked = maskValue([{ email: 'a@x.com' }, { token: 't' }]) as Array<
      Record<string, unknown>
    >;

    expect(masked[0].email).toBe('a***@x.com');
    expect(masked[1].token).toBe(REDACTED);
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2', email: 'a@x.com' };
    maskValue(input);

    expect(input.password).toBe('hunter2');
    expect(input.email).toBe('a@x.com');
  });

  it('handles circular references without overflowing', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    const masked = maskValue(node) as Record<string, unknown>;

    expect(masked.name).toBe('root');
    expect(masked.self).toBe('[Circular]');
  });

  it('preserves the stack of an Error while masking its message', () => {
    const error = new Error('failed for alice@example.com');
    const masked = maskValue(error) as { name: string; message: string; stack?: string };

    expect(masked.name).toBe('Error');
    expect(masked.message).toBe('failed for al***@example.com');
    expect(masked.stack).toBeDefined();
  });

  it('passes primitives through untouched', () => {
    expect(maskValue(42)).toBe(42);
    expect(maskValue(true)).toBe(true);
    expect(maskValue(null)).toBeNull();
    expect(maskValue(undefined)).toBeUndefined();
  });

  it('summarises buffers rather than dumping their contents', () => {
    expect(maskValue(Buffer.from('secret'))).toBe('[Buffer 6 bytes]');
  });

  it('stops descending past the depth limit', () => {
    // Build a chain deeper than MAX_DEPTH (8).
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };

    expect(JSON.stringify(maskValue(deep))).toContain('[MaxDepth]');
  });

  it('truncates very large arrays', () => {
    const masked = maskValue(new Array(150).fill('x')) as unknown[];

    expect(masked.length).toBe(101);
    expect(masked[100]).toBe('[+50 more]');
  });

  it('uses toJSON when an object provides one, as Mongoose documents do', () => {
    const doc = { toJSON: (): unknown => ({ email: 'doc@example.com', token: 'abc' }) };
    const masked = maskValue(doc) as Record<string, unknown>;

    expect(masked.email).toBe('do***@example.com');
    expect(masked.token).toBe(REDACTED);
  });
});
