# User and Profile API Reference

## Base URL

```text
/api/v1
```

All protected endpoints require:

```http
Authorization: Bearer <JWT>
```

Successful responses use the standard SwiftChain API envelope unless otherwise noted.

---

# User Status Lifecycle

`User.status` supports:

```text
active
suspended
banned
```

### Active

The account can authenticate normally.

### Suspended

The account remains stored but login/authenticated access is blocked by the authentication middleware.

Suspension metadata may include:

```text
suspendedReason
suspendedAt
```

### Banned

Banned accounts are also blocked by authentication middleware.

The authentication middleware rejects both:

```text
suspended
banned
```

with HTTP `403 Forbidden`.

---

# User Model

| Field               | Type      | Description                                 |
| ------------------- | --------- | ------------------------------------------- |
| `email`             | string    | Required, unique, lowercase                 |
| `password`          | string    | Hashed; excluded from normal JSON responses |
| `firstName`         | string    | Required                                    |
| `lastName`          | string    | Required                                    |
| `role`              | string    | `user`, `driver`, `admin`, `enterprise`     |
| `status`            | string    | `active`, `suspended`, `banned`             |
| `isActive`          | boolean   | Active flag                                 |
| `walletAddress`     | string    | Optional Stellar public key                 |
| `profilePicture`    | string    | Stored profile image URL                    |
| `profilePictureKey` | string    | Storage object key                          |
| `isDeleted`         | boolean   | Soft-delete flag                            |
| `deletedAt`         | date/null | Soft-delete timestamp                       |
| `deletedBy`         | string    | Actor responsible for deletion              |

---

# User Endpoints

## 1. Update Stellar Wallet

```http
PUT /api/v1/users/wallet
```

**Authentication:** Authenticated user

### Request Body

```json
{
  "walletAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

The validator uses Stellar SDK public-key validation. The address must be a valid Stellar Ed25519 public key.

### Example

```bash
curl -X PUT "http://localhost:3000/api/v1/users/wallet" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }'
```

### Errors

* `400` — invalid Stellar public key.
* `401` — authentication required.
* `404` — authenticated user no longer exists.
* `409` — wallet address is already linked to another account.

A wallet is unique across users through the `walletAddress` unique sparse index.

---

## 2. Get User by ID

```http
GET /api/v1/users/:id
```

**Authentication:** Authenticated user

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/users/65f000000000000000000001" \
  -H "Authorization: Bearer <JWT>"
```

### Errors

* `400` — invalid user ID.
* `401` — authentication required.
* `404` — user does not exist or is soft-deleted.

Soft-deleted users are excluded from the normal user lookup.

---

## 3. Update User

```http
PUT /api/v1/users/:id
```

**Authentication:** Admin

Allowed fields:

```text
firstName
lastName
role
status
walletAddress
profilePicture
profilePictureKey
```

### Example

```bash
curl -X PUT \
  "http://localhost:3000/api/v1/users/65f000000000000000000001" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Ada",
    "lastName": "Swift",
    "status": "active"
  }'
```

### Errors

* `400` — no valid fields supplied or invalid ID.
* `401` — authentication required.
* `403` — admin role required.
* `404` — user not found.

---

## 4. Soft Delete User

```http
DELETE /api/v1/users/:id
```

**Authentication:** Admin

The operation is a soft delete rather than a physical database deletion.

### Example

```bash
curl -X DELETE \
  "http://localhost:3000/api/v1/users/65f000000000000000000001" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

### Cascade Behavior

The service:

1. Sets `User.isDeleted = true`.
2. Sets `deletedAt`.
3. Records `deletedBy` when available.
4. Soft-deletes the associated `DriverProfile`, if present.
5. Soft-deletes related deliveries where the user is:

   * `driverId`
   * `userId`
   * `sender`
   * `recipient`

Related DriverProfile and Delivery records are **not automatically restored** when the user is restored.

---

## 5. List Deleted Users

```http
GET /api/v1/users/deleted
```

**Authentication:** Admin

### Query Parameters

| Parameter | Description                               |
| --------- | ----------------------------------------- |
| `role`    | Optional role filter                      |
| `status`  | Optional user-status filter               |
| `search`  | Searches email, first name, and last name |
| `page`    | Defaults to `1`                           |
| `limit`   | Defaults to `10`, maximum `100`           |

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/users/deleted?page=1&limit=10&search=swift" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

### Response

```json
{
  "status": "success",
  "data": [],
  "pagination": {
    "total": 0,
    "page": 1,
    "limit": 10,
    "totalPages": 0
  }
}
```

This endpoint returns only users where:

```text
isDeleted = true
```

---

## 6. Restore User

```http
POST /api/v1/users/:id/restore
```

**Authentication:** Admin

### Example

```bash
curl -X POST \
  "http://localhost:3000/api/v1/users/65f000000000000000000001/restore" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

### Errors

* `400` — invalid user ID.
* `401` — authentication required.
* `403` — admin role required.
* `404` — user not found.
* `409` — user is not currently deleted.

Restoring a user clears:

```text
isDeleted
deletedAt
deletedBy
```

The associated DriverProfile and Delivery records are **not** automatically restored.

---

## 7. Change Password

```http
PUT /api/v1/users/:id/password
```

**Authentication:** Authenticated user; only the user matching `:id` may change that password.

### Request Body

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

The new password must contain at least 8 characters.

### Example

```bash
curl -X PUT \
  "http://localhost:3000/api/v1/users/65f000000000000000000001/password" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "currentPassword": "old-password",
    "newPassword": "new-password"
  }'
```

The service loads the stored password explicitly and verifies the old password before saving the new password.

### Errors

* `400` — missing password fields, invalid ID, or new password shorter than 8 characters.
* `401` — authentication required or current password incorrect.
* `403` — attempting to change another user's password.
* `404` — user not found.

---

# Profile Endpoints

All profile routes require authentication.

## 8. Get Current Profile

```http
GET /api/v1/profile
```

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/profile" \
  -H "Authorization: Bearer <JWT>"
```

### Response

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "65f000000000000000000001",
      "email": "user@example.com",
      "firstName": "Ada",
      "lastName": "Swift",
      "role": "user",
      "status": "active",
      "profilePicture": "https://example.com/profile.jpg"
    }
  },
  "error": null,
  "message": "Profile retrieved successfully"
}
```

---

## 9. Upload Profile Picture

```http
POST /api/v1/profile/picture
```

**Authentication:** Authenticated user

Content type:

```text
multipart/form-data
```

File field:

```text
profilePicture
```

### Supported Types

```text
image/jpeg
image/jpg
image/png
image/webp
```

The configured default maximum is `5 MB`.

Images are validated with Sharp, resized to fit within the configured target dimensions, and converted to JPEG with the configured quality.

### Example

```bash
curl -X POST \
  "http://localhost:3000/api/v1/profile/picture" \
  -H "Authorization: Bearer <JWT>" \
  -F "profilePicture=@./profile.jpg"
```

### Response

```json
{
  "success": true,
  "data": {
    "userId": "65f000000000000000000001",
    "profilePicture": "https://example.com/profile.jpg",
    "profilePictureKey": "profiles/65f000000000000000000001/...",
    "uploadedAt": "2026-09-30T10:00:00.000Z"
  },
  "error": null,
  "message": "Profile picture uploaded successfully"
}
```

Storage is selected through `UPLOAD_STORAGE_DRIVER` and can use local storage or S3.

---

## 10. Delete Profile Picture

```http
DELETE /api/v1/profile/picture
```

**Authentication:** Authenticated user

### Example

```bash
curl -X DELETE \
  "http://localhost:3000/api/v1/profile/picture" \
  -H "Authorization: Bearer <JWT>"
```

### Errors

* `401` — authentication required.
* `404` — no profile picture exists.
* `500` — persistence failure.

The current implementation clears the user's profile-picture URL and storage key. Physical storage cleanup is marked as a future cleanup operation.

---

## Related Implementation

```text
src/routes/userRoutes.ts
src/controllers/userController.ts
src/routes/profileRoutes.ts
src/controllers/profileController.ts
src/models/User.ts
src/interfaces/IUser.ts
src/services/userService.ts
src/services/profilePicture.service.ts
src/services/storage.service.ts
src/validators/userValidator.ts
src/middleware/authenticate.ts
```
