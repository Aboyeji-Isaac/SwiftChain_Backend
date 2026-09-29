# JWT HttpOnly Cookies Refactor - Analysis Document

**Issue:** #124  
**Branch:** refactor/jwt-httponly-cookies  
**Date:** August 30, 2026

---

## Current State Analysis

### 1. Token Issuance (Current)

**File:** `src/services/authService.ts`
- **generateToken()** (line 58-69): Creates JWT with `userId` and `role` claims
- **Expiry:** From `process.env.JWT_EXPIRES_IN` (default: '7d')
- **Secret:** From `process.env.JWT_SECRET`
- **Return:** Raw token string

**File:** `src/controllers/authController.ts`
- **login endpoint** (line 11-23): Returns token in response body JSON
- **Current Response:**
```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "user": { "id", "email", "firstName", "lastName", "role" },
    "token": "<JWT_STRING>"  // ← EXPOSED TO CLIENT JS
  }
}
```

### 2. Token Verification (Current)

**File:** `src/middlewares/authMiddleware.ts`
- **Extraction:** Reads `Authorization: Bearer <token>` header (line 26-35)
- **Verification:** `jwt.verify()` with `env.JWT_SECRET` (line 41)
- **Error Handling:** Returns 401 on missing/invalid/expired token
- **User Attachment:** Decoded JWT attached to `req.user`

### 3. Routes

**File:** `src/routes/authRoutes.ts`
- `POST /api/v1/auth/login` - Issue token
- `POST /api/v1/auth/register` - Create account
- No logout endpoint exists

### 4. Environment Configuration

**File:** `src/config/env.ts`
- `NODE_ENV`: 'development' | 'test' | 'production'
- `JWT_SECRET`: From env, min 16 chars
- `JWT_EXPIRES_IN`: From env, default '7d'
- No existing cookie configuration

### 5. Security Findings

✅ **Strengths:**
- JWT verification using strong secret
- Rate limiting on login endpoint
- Password properly hashed with bcrypt
- Bearer token in Authorization header (not in URL/body)

⚠️ **Weaknesses (XSS Risk):**
- Token returned in response body → accessible to JavaScript
- XSS would expose token immediately
- No HttpOnly cookie protection
- No CSRF protection (once HttpOnly cookies are used)
- No logout endpoint to clear session

❌ **Gaps:**
- No CSRF middleware
- No logout functionality
- No refresh token mechanism
- No cookie-based session support

---

## Planned Solution

### 1. Cookie Configuration

**HttpOnly Cookie Settings:**
```typescript
{
  name: 'authToken',           // Clear name
  httpOnly: true,              // NO client-side JS access ✓
  secure: env.NODE_ENV === 'production',  // HTTPS only in prod
  sameSite: 'strict',          // Strong CSRF protection
  path: '/api',                // Scoped to API routes
  maxAge: parseJwtExpiry(JWT_EXPIRES_IN),  // Match JWT expiry
  signed: true                 // Optional: sign cookie value
}
```

**Rationale:**
- `HttpOnly: true` → XSS can't steal the token
- `Secure: true` (prod only) → HTTPS only (prevents MITM)
- `SameSite: strict` → No cross-site requests with cookie
- `Path: /api` → Cookie sent only to `/api/*` routes
- `maxAge` → Matches JWT expiry to keep sync

### 2. CSRF Protection Approach

**Selected: Double-Submit Cookie Pattern**

**Why:**
- Stateless (no session storage needed)
- Works with existing architecture
- Simple to implement
- Standard practice for SPA + API pattern

**Implementation:**
```typescript
// Login Response: Set TWO cookies
1. authToken (HttpOnly, Secure) - Server-verified JWT
2. csrfToken (Regular cookie, Secure) - Readable by JS

// Protected Endpoints: Require
- authToken cookie (automatic)
- X-CSRF-Token header (JavaScript must send)

// Verification:
- Extract CSRF token from X-CSRF-Token header
- Extract CSRF token from csrfToken cookie
- Compare: they must match
- If mismatch → 403 Forbidden
```

**Advantages:**
- No server-side CSRF token storage
- Scales horizontally (stateless)
- Simple to verify
- Clear error messages

### 3. Affected Endpoints

**State-Changing Operations (require CSRF):**
- `POST /api/v1/deliveries` - Create delivery
- `PUT /api/v1/deliveries/:id` - Update delivery
- `PATCH /api/v1/drivers/me/vehicle` - Update profile
- `POST /api/v1/disputes` - Create dispute
- All admin operations
- Etc. (all POST/PUT/PATCH/DELETE)

**Safe Endpoints (no CSRF needed):**
- `GET` requests (read-only)
- `POST /api/v1/auth/login` (before auth)
- `POST /api/v1/auth/register` (before auth)

### 4. Changes Required

#### `src/services/authService.ts`
- Add `generateCsrfToken()` method
- Modify `login()` to return CSRF token alongside JWT

#### `src/controllers/authController.ts`
- Modify `login()` to set HttpOnly cookies (authToken + csrfToken)
- Remove token from response body
- Add `logout()` endpoint (clear cookies)

#### `src/middlewares/authMiddleware.ts` (or new `src/middlewares/auth.ts`)
- Modify to read JWT from `req.cookies.authToken` instead of header
- Preserve all verification logic
- Clear error messages for missing/invalid cookies

#### `src/middlewares/csrf.ts` (NEW)
- Extract CSRF token from `X-CSRF-Token` header
- Extract CSRF token from cookies
- Compare and validate
- Pass through on match, reject on mismatch

#### `src/routes/authRoutes.ts`
- Add `POST /api/v1/auth/logout` route
- Update `POST /api/v1/auth/login` documentation

#### `src/app.ts`
- Import cookie-parser middleware (already available: express does cookies)
- Apply CSRF middleware to state-changing routes

### 5. API Contract Changes

**BREAKING CHANGE FOR FRONTEND:**

**Old (Current):**
```typescript
// Request
POST /api/v1/auth/login
Content-Type: application/json
{ "email": "user@example.com", "password": "..." }

// Response
200 OK
{
  "status": "success",
  "data": {
    "user": {...},
    "token": "eyJhbGc..." ← FRONTEND STORES IN localStorage
  }
}

// Subsequent Requests
GET /api/v1/deliveries
Authorization: Bearer eyJhbGc...
```

**New (HttpOnly Cookies):**
```typescript
// Request
POST /api/v1/auth/login
Content-Type: application/json
{ "email": "user@example.com", "password": "..." }

// Response
200 OK
Set-Cookie: authToken=<JWT>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=604800
Set-Cookie: csrfToken=<token>; Secure; SameSite=Strict; Path=/api; Max-Age=604800
{
  "status": "success",
  "data": {
    "user": {...}
    // NO "token" key ← COOKIES AUTO-SENT BY BROWSER
  }
}

// Subsequent Requests (Automatic Cookie + CSRF)
GET /api/v1/deliveries
(authToken cookie auto-sent by browser)

// State-changing Requests
POST /api/v1/deliveries
X-CSRF-Token: <csrfToken_value>
(authToken + csrfToken cookies auto-sent)
```

**Frontend Changes Required:**
1. Remove `localStorage.getItem('token')` logic
2. Remove `Authorization: Bearer ...` header injection
3. Add `X-CSRF-Token` header for state-changing requests (get csrfToken from cookies)
4. Ensure credentials: 'include' in fetch/axios for cross-origin requests

### 6. Logout Flow

```typescript
// Request
POST /api/v1/auth/logout
(authToken cookie sent auto)

// Response
200 OK
Set-Cookie: authToken=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0
Set-Cookie: csrfToken=; Secure; SameSite=Strict; Path=/api; Max-Age=0
{
  "status": "success",
  "message": "Logged out successfully"
}
```

**Key:** Same cookie attributes, `Max-Age=0` expires it immediately.

---

## Implementation Plan

### Phase 1: Middleware & Services
1. Create CSRF token generation utility
2. Update authService with CSRF token generation
3. Create CSRF validation middleware
4. Update authMiddleware to read from cookies

### Phase 2: Controllers & Routes
1. Update authController.login() to set cookies
2. Update authController to remove token from response
3. Add logout() method to authController
4. Add logout route to authRoutes

### Phase 3: Integration
1. Apply CSRF middleware to all state-changing routes
2. Update app.ts to include cookie parsing
3. Verify backward compatibility (or document breaking change)

### Phase 4: Testing
1. Login sets correct cookie attributes (HttpOnly, Secure, SameSite, Path, Max-Age)
2. Auth middleware reads from cookie correctly
3. CSRF validation requires correct header
4. Logout clears cookies properly
5. No token in response body
6. Expired/tampered cookies rejected with 401

---

## Files to Modify/Create

### New Files
- `src/middlewares/csrf.ts` - CSRF validation middleware
- `src/utils/csrf.ts` - CSRF token generation utility
- `tests/auth.httponly.test.ts` - Comprehensive auth tests

### Modified Files
- `src/services/authService.ts` - Add CSRF token generation
- `src/controllers/authController.ts` - Cookie setting + logout
- `src/middlewares/authMiddleware.ts` - Cookie reading
- `src/routes/authRoutes.ts` - Add logout route
- `src/app.ts` - Apply CSRF middleware

---

## Cookie Attributes Reference

| Attribute | Value | Purpose |
|-----------|-------|---------|
| `HttpOnly` | true | Prevents JavaScript access (XSS protection) |
| `Secure` | NODE_ENV === 'production' | HTTPS only in prod (prevents MITM) |
| `SameSite` | strict | Prevents cross-site cookie sending (CSRF) |
| `Path` | /api | Cookie sent only to /api/* routes |
| `Max-Age` | 604800 (7d) | Cookie expires after 7 days |
| `Domain` | (optional) | Restrict to specific domain if needed |
| `signed` | true | (optional) Express signs cookie with secret |

---

## Breaking Changes

**This PR introduces a breaking change to the authentication API contract.**

**Frontend must:**
1. Remove localStorage token handling
2. Add X-CSRF-Token header to state-changing requests
3. Set credentials: 'include' for cross-origin requests
4. Update error handling (401 from missing cookie)

**Backward Compatibility Options:**
1. **Transition Period:** Support both Bearer token and HttpOnly cookies (accept from both sources)
2. **Hard Break:** Remove Bearer support entirely (faster cleanup)

**Recommended:** Hard break + clear migration documentation (simpler, cleaner)

---

## Success Criteria

✅ Login sets HttpOnly cookie with correct attributes  
✅ AuthMiddleware reads from cookie instead of header  
✅ CSRF tokens required for state-changing requests  
✅ Logout clears both cookies  
✅ No token in response body  
✅ Expired/tampered cookies return 401  
✅ Comprehensive test coverage  
✅ Documentation for frontend changes  

---

## References

- RFC 6265: HTTP State Management Mechanism (Cookies)
- OWASP: Cross-Site Request Forgery (CSRF)
- OWASP: HttpOnly Cookies for XSS Protection
- Node.js Express: Cookie Handling
