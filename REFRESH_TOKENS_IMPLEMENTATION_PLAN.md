# Refresh Token Implementation Plan - Issue #125

## Analysis Summary

### Current State
- **Access Token (Current)**: JWT with 7-day expiry (default), issued in response body
- **Delivery**: Bearer token in Authorization header (not yet HttpOnly cookies per #124)
- **Middleware**: `authMiddleware.ts` verifies Bearer token from Authorization header
- **Auth Flow**: Login → generate single JWT → return in response body
- **User Roles**: 4 roles (USER, DRIVER, ADMIN, ENTERPRISE) in existing User model
- **Storage**: No token/session model exists yet
- **No logout endpoint**: Currently no way to invalidate tokens

### Assumptions
1. **Issue #124 (HttpOnly Cookies) is NOT yet implemented** — current code shows Bearer token delivery
2. **This refresh token implementation assumes Bearer token continuation** — if #124 lands first, we'll adapt to cookie delivery
3. **MongoDB is available** for storing refresh token records (already in use for User model)
4. **Redis available** (already configured in project for caching/locking)

---

## Proposed Design

### 1. Token Lifecycle & Configuration

**New Environment Variables:**

```env
# Access token expiry (short-lived). Default: 15m
JWT_ACCESS_EXPIRES_IN=15m

# Refresh token expiry (long-lived). Default: 7d
JWT_REFRESH_EXPIRES_IN=7d

# Separate signing secret for refresh tokens (security best practice)
JWT_REFRESH_SECRET=your-refresh-secret-key-change-this
```

**Token Lifetimes** (Recommended):
- **Access Token**: 15 minutes (configurable)
  - Short expiry minimizes damage from leaked token
  - Frequent refresh encourages server-side validation
- **Refresh Token**: 7 days (configurable)
  - Long enough for practical "stay logged in" UX
  - Short enough to limit blast radius if leaked
  - Can be rotated (new one issued per refresh) to further limit exposure

### 2. Refresh Token Storage Strategy

**Model: `RefreshToken` (MongoDB)**

```typescript
interface IRefreshToken extends Document {
  userId: string;                    // FK to User._id
  tokenId: string;                   // Unique identifier (jti claim)
  tokenHash: string;                 // SHA-256 hash of raw refresh token (never store plaintext)
  expiresAt: Date;                   // Expiry timestamp
  isRevoked: boolean;                // Soft delete flag for logout/revocation
  userAgent?: string;                // Optional: device fingerprinting
  ipAddress?: string;                // Optional: device fingerprinting
  createdAt: Date;
  updatedAt: Date;
}
```

**Why This Design**:
- **Hashed storage**: Never store raw tokens; hash ensures if DB is compromised, tokens aren't immediately usable
- **JTI (tokenId)**: UUID per token allows individual lookup/revocation without comparing all hashes
- **Soft delete (isRevoked)**: Enables "revoke all" queries and logout
- **Device fingerprinting**: Optional metadata for "log out everywhere" or suspicious activity detection
- **Expiry tracking**: MongoDB TTL index can auto-delete expired records

### 3. Rotation Strategy & Reuse Detection

**Decision: Implement Token Rotation with Reuse Detection**

**Why**:
- Each refresh mints a NEW refresh token and invalidates the OLD one
- Limits blast radius: if token family is leaked, only the most recent token works
- Reuse detection: if old token is presented again, likely indicator of theft
  - Action: Revoke entire token family for that user (defensive measure)
  - User forced to re-login

**Implementation**:
- Store `familyId` in refresh token record to group rotated tokens
- On reuse: detect by checking if token's `familyId` already has a newer token, then mark entire family revoked

### 4. Token Issuance (Modified Login)

**Flow**:
```
Login Request (email + password)
  ↓
Authenticate user (existing logic)
  ↓
Generate TWO tokens:
  • Access Token (JWT, 15 min, contains userId + role)
  • Refresh Token (JWT, 7 days, contains userId + tokenId + familyId)
  ↓
Store hashed refresh token in MongoDB (with metadata)
  ↓
Return both tokens:
  • In response body (for now, Bearer delivery)
  • OR in HttpOnly cookies (if #124 lands before this)
  ↓
Client stores refresh token securely and uses access token
```

**New Auth Service Method**:
```typescript
issueTokenPair(userId: string, role: string): {
  accessToken: string;
  refreshToken: string;
}
```

### 5. Refresh Endpoint

**Endpoint**: `POST /api/v1/auth/refresh`

**Request**:
```json
{
  "refreshToken": "eyJhbGci..."
}
```

**Response (Success 200)**:
```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJhbGci...",
    "refreshToken": "eyJhbGci..."  // New refresh token (rotated)
  }
}
```

**Response (Failure)**:
- **401 Unauthorized**:
  - Token missing/malformed
  - Token expired
  - Token revoked (logout)
  - Token tampered (invalid signature)
  - Reuse detected (family revoked)
  - User deactivated

**Server Logic**:
1. Extract refresh token from request body (or cookie, if #124 lands)
2. Verify JWT signature + expiry
3. Look up token in MongoDB by `tokenId` (jti claim)
4. Check `isRevoked`, expiry, user status
5. Detect reuse: check if `familyId` has a newer token → revoke family
6. Issue new token pair, invalidate old token, save new token record
7. Return new tokens

### 6. Logout Endpoint

**Endpoint**: `DELETE /api/v1/auth/logout` (or `POST /api/v1/auth/logout`)

**Request** (Authenticated):
```json
{}
```

**Response (Success 200)**:
```json
{
  "status": "success",
  "message": "Logged out successfully"
}
```

**Server Logic**:
1. Extract userId from authenticated request (via existing auth middleware)
2. Mark associated refresh token as `isRevoked: true`
3. Return success
4. Client deletes refresh token from storage

**"Logout Everywhere" (Optional, for future)**:
```
DELETE /api/v1/auth/logout-all
→ Mark ALL refresh tokens for user as revoked
```

### 7. Auth Middleware Update

**Current**: Verifies Bearer access token

**No change needed** for existing authenticated endpoints (they continue to verify access token).

**New flow**:
- Access token expires → client calls `/api/v1/auth/refresh`
- `/api/v1/auth/refresh` accepts and validates refresh token
- Client gets new access token → continues using existing endpoints

### 8. Backward Compatibility

**Assessment**: PRESERVES 100% compatibility
- Login endpoint still returns tokens in response body (until #124 changes delivery mechanism)
- Existing authenticated endpoints unchanged (Bearer token verification unchanged)
- New refresh endpoint is optional; clients can ignore it (but won't get prolonged sessions)
- No schema/API breaking changes

---

## Implementation Checklist

### Phase 1: Setup
- [ ] Add refresh token env variables to `.env.example`
- [ ] Update `env.ts` with new vars (JWT_ACCESS_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN, JWT_REFRESH_SECRET)
- [ ] Create `RefreshToken.ts` model + interface `IRefreshToken.ts`
- [ ] Create MongoDB TTL index on `expiresAt` for auto-cleanup

### Phase 2: Token Service
- [ ] Create `tokenService.ts` with:
  - `issueTokenPair(userId, role): { accessToken, refreshToken }`
  - `verifyRefreshToken(token): { userId, tokenId, familyId }`
  - `storeRefreshToken(userId, token, expiresAt): void`
  - `revokeRefreshToken(tokenId): void`
  - `revokeAllRefreshTokens(userId): void`
  - `detectReuse(tokenId, familyId): { isReused: boolean }`

### Phase 3: Auth Service Updates
- [ ] Update `authService.login()` to call `issueTokenPair()` instead of single token
- [ ] Update return type `IAuthResponse` to include both tokens
- [ ] Update `authService` to call `tokenService.storeRefreshToken()`

### Phase 4: Auth Controller & Routes
- [ ] Update `authController.login()` to return both tokens
- [ ] Create `authController.refresh()` endpoint
- [ ] Create `authController.logout()` endpoint
- [ ] Add routes: POST `/api/v1/auth/refresh`, DELETE `/api/v1/auth/logout`

### Phase 5: Tests
- [ ] Unit tests for `tokenService` (issuance, verification, storage, revocation)
- [ ] Integration tests for login → refresh → logout flow
- [ ] Test reuse detection and family revocation
- [ ] Test expiry, tampering, revocation error cases
- [ ] Verify hashed storage (no plaintext refresh tokens in DB)

### Phase 6: Documentation & Proof
- [ ] Update OpenAPI/Swagger schemas for login, refresh, logout
- [ ] Create integration test with real DB and capture output
- [ ] Screenshot of login response with both tokens
- [ ] Screenshot of refresh response with new tokens
- [ ] Screenshot of refresh failing after logout
- [ ] All tests passing output

---

## File Summary

### New Files to Create
1. **`src/models/RefreshToken.ts`** — Mongoose schema for refresh token storage
2. **`src/interfaces/IRefreshToken.ts`** — TypeScript interface for refresh token
3. **`src/services/tokenService.ts`** — Token lifecycle management (issue, verify, revoke)

### Files to Modify
1. **`src/config/env.ts`** — Add JWT_ACCESS_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN, JWT_REFRESH_SECRET
2. **`.env.example`** — Add new env variables
3. **`src/services/authService.ts`** — Update login to issue token pair
4. **`src/interfaces/IUser.ts`** — Update IAuthResponse to include both tokens
5. **`src/controllers/authController.ts`** — Add refresh() and logout() methods
6. **`src/routes/authRoutes.ts`** — Add refresh and logout routes

### New Test Files
1. **`tests/tokenService.test.ts`** — Unit tests for token lifecycle
2. **`tests/auth.refresh.integration.test.ts`** — Integration tests for refresh flow

---

## Security Considerations

✅ **Hashed Storage**: Refresh tokens stored as SHA-256 hashes (never plaintext)
✅ **Separate Secrets**: Access and refresh tokens use distinct signing secrets
✅ **Short Access Expiry**: 15 min minimizes leaked token window
✅ **Rotation**: New refresh token per refresh limits blast radius
✅ **Reuse Detection**: Old token reuse triggers family revocation (theft indicator)
✅ **Revocation**: Logout immediately marks token revoked
✅ **Device Fingerprinting**: Optional metadata (userAgent, IP) for future anomaly detection
✅ **TTL Index**: Expired tokens auto-deleted from DB

---

## Interaction with Issue #124 (HttpOnly Cookies)

**If #124 lands before or concurrent with this work:**
- Modify token delivery from response body to HttpOnly cookies
- Access token cookie: HttpOnly, Path=/api, 15 min expiry
- Refresh token cookie: HttpOnly, Path=/api/v1/auth/refresh, 7 day expiry
- `/api/v1/auth/refresh` endpoint reads refresh token from cookie (no body param needed)
- Other endpoints unchanged (continue reading access token from cookie)

**Current Assumption**: Bearer tokens in response body (pre-#124 state)

---

## Estimated Effort

- **Phase 1-2**: 2-3 hours (models, service, env setup)
- **Phase 3-4**: 2-3 hours (auth updates, routes, controller)
- **Phase 5**: 3-4 hours (comprehensive testing)
- **Phase 6**: 1 hour (docs, screenshots, proof)

**Total**: ~8-11 hours of implementation + review

---

## Success Criteria

✓ Login endpoint returns both access and refresh tokens
✓ Refresh endpoint successfully exchanges valid refresh token for new access token
✓ Refresh endpoint rejects: expired, revoked, tampered, reused tokens
✓ Logout revokes token and subsequent refresh fails
✓ Refresh tokens stored hashed (verified against MongoDB)
✓ Entire token family revoked on reuse detection
✓ All tests pass with real database
✓ Screenshots demonstrating full flow (login → refresh → logout)
✓ PR includes "Closes #125" and strategy summary
✓ CONTRIBUTING.md compliance verified
