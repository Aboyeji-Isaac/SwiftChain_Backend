# Authentication and Security Model

This document is the reference for adding or reviewing protected API endpoints in SwiftChain Backend. It describes the controls that are already enforced by the current codebase and the order in which contributors should apply them.

## Request security stack

A typical protected mutation passes through these controls:

1. Global HTTP hardening in `src/app.ts`: Helmet, CORS, request logging, and the global `/api` rate limiter.
2. Route authentication with `authenticate`.
3. Role authorization with `requireRole(...roles)` when the operation is role restricted.
4. `requireIdempotencyKey` for mutations that must be safe to retry.
5. Controller validation and delegation to the service layer.

Keep the existing architecture boundary intact:

```text
Route / middleware -> Controller -> Service -> Repository -> Model
```

Security middleware belongs at the route boundary. Controllers should not reimplement JWT, RBAC, rate limiting, CORS, or idempotency logic.

## JWT authentication

### Token issuance

`src/services/authService.ts` issues the access token after a successful email/password login.

The signed JWT payload is:

```ts
{ userId, role }
```

It is signed with `env.JWT_SECRET` and expires according to `env.JWT_EXPIRES_IN` (currently defaulting to `7d` in `src/config/env.ts`).

Do not put passwords, password hashes, wallet secrets, private keys, refresh credentials, or other sensitive material in a JWT payload.

### Two verification paths exist

There is an important difference between the service helper and HTTP route authentication.

#### `authService.verifyToken(token)`: payload-only verification

`src/services/authService.ts` calls `jwt.verify`, extracts a user identifier from the decoded payload, and returns it.

It does **not** reload the user from MongoDB and does not independently check current account status or role. Use it only where payload-only token verification is deliberately sufficient.

#### `authenticate`: DB-backed route authentication

`src/middleware/authenticate.ts` is the authentication middleware for protected HTTP routes. It:

- requires `Authorization: Bearer <token>`;
- verifies the signature and expiry with `JWT_SECRET`;
- loads the user from MongoDB using the decoded `userId`;
- returns 401 if the user no longer exists;
- returns 403 for `suspended` or `banned` users;
- attaches the current user document to `req.user` for downstream authorization.

Use `authenticate` for protected API routes rather than calling `authService.verifyToken` in controllers.

### Expiry and refresh

Expired access tokens are rejected by `jwt.verify` and produce a 401 from `authenticate`.

The current live auth controller/routes expose login and registration; there is no wired refresh-token endpoint in that path. Planning documents may discuss refresh tokens, but contributors must not assume a refresh flow exists until it is implemented and routed. With the current implementation, a client that no longer has a valid access token must authenticate again to receive another one.

## Role-based access control

The canonical roles in `src/interfaces/IUser.ts` are:

| Role | Value |
| --- | --- |
| User | `user` |
| Driver | `driver` |
| Admin | `admin` |
| Enterprise | `enterprise` |

`src/middleware/requireRole.ts` is the current RBAC middleware factory.

It must run after `authenticate`:

```ts
router.patch(
  '/v1/example/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  controller.update,
);
```

Behavior:

- no authenticated `req.user` -> 401;
- authenticated user whose role is not in the allow-list -> 403;
- allowed role -> request continues.

Pass every role that is intentionally allowed. Do not reproduce role checks with ad-hoc string comparisons in controllers or services.

The current tree uses `requireRole` as the explicit route RBAC factory. If a future `authorize` helper is introduced, it should delegate to the same role model rather than creating a second authorization policy.

## Rate limiting

There are two layers of HTTP rate limiting.

### Global `/api` limiter

`src/app.ts` installs an `express-rate-limit` instance on all `/api` routes using:

- `RATE_LIMIT_WINDOW_MS`, default 900,000 ms (15 minutes);
- `RATE_LIMIT_MAX_REQUESTS`, default 100 requests.

These values come from validated environment configuration.

### Named route limiters

`src/middlewares/rateLimiter.ts` exports:

| Limiter | Production limit | Window | Intended use |
| --- | ---: | ---: | --- |
| `authLimiter` | 10 requests | 15 minutes | Login/register and other credential-sensitive endpoints |
| `apiLimiter` | 200 requests | 15 minutes | General public API routes that opt into this limiter |

Both use standard rate-limit headers and disable legacy headers.

In Jest/test environments the named limiters use an effectively unbounded maximum so test suites are not made flaky by request counts.

Do not create a new limiter inside a controller. Reuse an existing limiter or add a named limiter alongside these if a genuinely different policy is required.

## Idempotency

`src/middlewares/idempotency.ts` provides `requireIdempotencyKey` for mutations that must be safe to retry.

Place it after authentication and before the controller:

```ts
authenticate,
requireRole(...),
requireIdempotencyKey,
controller.action
```

The header is:

```text
Idempotency-Key
```

Keys must be non-empty and no longer than 128 characters. UUID v4 is recommended.

The endpoint discriminator is built from the request method, base URL, and path, so a key can be reused on a different endpoint without colliding with the first request.

### Responses

- Missing, blank, or oversized key -> **422 Unprocessable Entity**.
- The same key is already `processing` -> **409 Conflict** and `Idempotency-Key-Status: processing`.
- A previously `completed` or `failed` request -> cached status/body is replayed without re-running the handler.
- A replay sets:
  - `Idempotency-Key-Status`
  - `Idempotency-Key-Replay: true`

For a first request, the middleware records the key as processing and wraps `res.json` so the resulting status/body can be persisted as completed (2xx) or failed (non-2xx).

Do not perform irreversible work before this middleware has acquired/recorded the key.

## CORS

CORS policy lives in `src/config/security.ts` and is installed globally by `src/app.ts`.

`CORS_ORIGIN` is parsed as a comma-separated allow-list.

Rules:

- requests with no `Origin` header are allowed (for example server-to-server, curl, mobile clients);
- `*` in the configured allow-list permits any origin;
- otherwise the request origin must exactly match one configured origin;
- a disallowed origin is rejected with **403**.

Current options include:

- credentials enabled;
- methods: GET, POST, PUT, PATCH, DELETE, OPTIONS;
- allowed headers: `Content-Type`, `Authorization`, `X-Requested-With`;
- exposed rate-limit headers;
- preflight max age of 86,400 seconds;
- successful OPTIONS status 204.

For production, prefer explicit trusted origins instead of `*`, especially because credentials are enabled.

## Helmet, CSP, and HSTS

`src/app.ts` installs Helmet using `helmetOptions` from `src/config/security.ts`.

The application policy includes:

- `default-src 'self'`;
- `base-uri 'self'`;
- scripts from `'self'`;
- objects blocked with `object-src 'none'`;
- framing blocked with `frame-ancestors 'none'`;
- image sources limited to `'self'` and `data:`;
- referrer policy `no-referrer`;
- cross-origin resource policy `same-site`;
- upgrade-insecure-requests;
- HSTS for one year, including subdomains, with preload enabled.

The `/api-docs` Swagger UI has a deliberately scoped CSP relaxation for the inline script/style that Swagger requires. Do not copy that relaxed policy to general API routes.

## Logging and PII masking

All application logging should go through `src/config/logger.ts`.

The logger installs the PII masker before its transports, so console output, rotating files, and future transports receive already-redacted records. If masking itself fails, the logger suppresses the original record rather than allowing potentially sensitive data through unmasked.

`src/utils/piiMasker.ts` protects both structured metadata and free text.

Examples include:

- passwords, passphrases, tokens, secrets, API keys, authorization headers, cookies, session identifiers, signatures, signed XDR, mnemonics, seeds, OTPs, PINs, CVVs and client secrets -> fully redacted by sensitive key;
- JWTs and bearer/basic credentials -> fully redacted;
- Stellar `S...` secret seeds and PEM private keys -> fully redacted;
- credentialed connection-string passwords -> redacted;
- emails, phone numbers, payment-card numbers, and public Stellar `G...`/`C...` identifiers -> partially masked where operationally useful.

Masking is defense in depth, not permission to log secrets. Never intentionally log:

- raw passwords or password hashes;
- JWTs or bearer headers;
- Stellar secret seeds/private keys;
- API keys or cloud credentials;
- cookies/session tokens;
- full connection strings containing credentials;
- signed payloads that may contain sensitive authorization material.

Log identifiers and safe operational metadata instead.

## Secret handling

Configuration is centralized in `src/config/env.ts` and validated with Zod at startup.

Contributors should:

- read secrets through validated `env`, not hard-code them;
- keep real `.env` values out of source control;
- never include secrets in error messages, API responses, screenshots, tests, fixtures, or logs;
- use placeholders in documentation and example environment files;
- treat Stellar secret seeds exactly like any other spending credential.

`JWT_SECRET` must be replaced with a deployment-specific secret in production; development defaults are not production credentials.

## Example: protected, role-gated, idempotent mutation

A protected mutation should compose the shared middleware instead of reimplementing controls:

```ts
import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';
import { apiLimiter } from '../middlewares/rateLimiter';
import { requireIdempotencyKey } from '../middlewares/idempotency';
import controller from '../controllers/exampleController';

const router = Router();

router.post(
  '/v1/example',
  apiLimiter,
  authenticate,
  requireRole(UserRole.USER, UserRole.ENTERPRISE),
  requireIdempotencyKey,
  controller.create,
);

export default router;
```

The controller should then validate/extract the HTTP input, delegate business logic to a service, and return the result. Data access belongs in the repository layer.

## Protected-endpoint checklist

Before adding or reviewing a protected endpoint, verify:

- [ ] Route is versioned under `/api/v1/`.
- [ ] External input is validated at the HTTP boundary.
- [ ] `authenticate` runs before code that depends on the current user.
- [ ] `requireRole(...)` is present when the operation is role restricted.
- [ ] Retry-sensitive mutations use `requireIdempotencyKey`.
- [ ] An appropriate shared rate limiter applies.
- [ ] Controller delegates business logic to the service layer.
- [ ] Service uses repositories instead of querying Mongoose models directly.
- [ ] Errors use the shared error path and do not expose secrets.
- [ ] Logs contain safe identifiers only; no raw credentials or secret material.
- [ ] CORS/Helmet policy is not weakened for the endpoint.
- [ ] Tests cover unauthenticated, unauthorized, validation, and retry behavior where applicable.

## Source of truth

When this document and code disagree, the code is authoritative. Update this document in the same PR whenever a security control, limit, role, header, authentication flow, or middleware order changes.
