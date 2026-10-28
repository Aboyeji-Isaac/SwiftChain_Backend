# Storage and Upload Reference

## Overview

SwiftChain uses a storage-driver abstraction for uploaded files.

The active driver is selected by:

```env
UPLOAD_STORAGE_DRIVER=local
```

Supported drivers:

```text
local
s3
```

The factory is implemented in:

```text
src/services/storage.service.ts
```

The primary upload surfaces covered by this document are:

* Profile pictures.
* Dispute evidence.
* Proof of delivery.

---

## Storage Driver Selection

The storage factory is:

```ts
getStorageDriver()
```

The selection logic is:

```text
UPLOAD_STORAGE_DRIVER=s3
        │
        ▼
S3StorageDriver

UPLOAD_STORAGE_DRIVER=local
        │
        ▼
LocalStorageDriver
```

The resolved driver is cached for the lifetime of the process.

### Configuration

```env
UPLOAD_STORAGE_DRIVER=local
UPLOAD_LOCAL_DIR=uploads
```

For S3:

```env
UPLOAD_STORAGE_DRIVER=s3
AWS_S3_BUCKET=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_SIGNED_URL_EXPIRES_SECONDS=3600
```

`AWS_S3_BUCKET` is required when S3 is selected.

---

## Local Storage

**Implementation:**

```text
src/services/storage.service.ts
```

`LocalStorageDriver` writes files under:

```text
<process.cwd()>/<UPLOAD_LOCAL_DIR>/<key>
```

The default local directory is:

```env
UPLOAD_LOCAL_DIR=uploads
```

The generated URL uses:

```text
<APP_BASE_URL>/uploads/<key>
```

Example:

```text
http://localhost:3000/uploads/evidence/1700000000000-uuid.pdf
```

Local storage is intended primarily for development and deployments where local filesystem persistence is appropriate.

It is not suitable for horizontally scaled deployments unless the upload directory is backed by shared durable storage.

---

## S3 Storage

`S3StorageDriver` writes objects using:

```text
PutObjectCommand
```

The returned client URL is generated with:

```text
GetObjectCommand
getSignedUrl()
```

The expiry is controlled by:

```env
AWS_S3_SIGNED_URL_EXPIRES_SECONDS=3600
```

The URL is therefore temporary and does not make the object permanently public.

### S3 request flow

```text
Upload request
     │
     ▼
Validate upload
     │
     ▼
S3 PutObject
     │
     ▼
Generate signed GetObject URL
     │
     ▼
Persist storage metadata
     │
     ▼
Return stored object information
```

---

## Object Keys

`storage.service.ts` generates collision-resistant keys using:

```text
Date.now()
crypto.randomUUID()
```

The file extension is preserved.

If an upload already provides a path-like name, that path is retained.

Examples:

```text
evidence/<timestamp>-<uuid>.jpg
proof-of-delivery/<deliveryId>/<originalName>
```

---

# Profile Pictures

**Implementation:**

```text
src/services/profilePicture.service.ts
```

### Who may upload

The service requires a valid user ID and verifies that the user exists.

### Allowed MIME types

```text
image/jpeg
image/jpg
image/png
image/webp
```

### Input size

Default maximum:

```env
PROFILE_PICTURE_MAX_SIZE_MB=5
```

### Processing

Sharp processes the source image before storage.

Defaults:

```env
PROFILE_PICTURE_WIDTH=500
PROFILE_PICTURE_HEIGHT=500
PROFILE_PICTURE_QUALITY=85
```

The image is resized to fit within the configured dimensions while preserving its aspect ratio and encoded as JPEG using the configured quality.

The stored MIME type is:

```text
image/jpeg
```

### Replacement cleanup

When replacing an existing profile picture, the service tracks the previous storage key and attempts to remove the old stored object before updating the user's profile metadata.

The cleanup behaviour should be treated as best-effort and operators should inspect storage logs if orphaned objects are suspected.

---

# Dispute Evidence

**Implementation:**

```text
src/services/evidenceService.ts
```

### Upload access

The evidence route is authenticated.

### Allowed MIME types

```text
image/jpeg
image/png
image/webp
video/mp4
video/quicktime
application/pdf
```

### Maximum size

```env
UPLOAD_MAX_FILE_SIZE_MB=10
```

The service rejects files larger than the configured limit.

### Validation errors

| Condition               |                    HTTP status |
| ----------------------- | -----------------------------: |
| Invalid dispute ID      |              `400 Bad Request` |
| Unsupported MIME type   |   `415 Unsupported Media Type` |
| File exceeds size limit | `413 Request Entity Too Large` |

After successful storage, the service creates an `Evidence` record containing:

```text
disputeId
uploadedBy
storageDriver
storageKey
url
originalName
mimeType
sizeBytes
```

---

# Proof of Delivery

**Implementation:**

```text
src/services/proofOfDeliveryService.ts
```

### Who may upload

The service requires:

* A valid delivery ID.
* An existing delivery.
* A non-terminal delivery.
* The assigned driver or an authorized admin.

### Allowed MIME types

```text
image/jpeg
image/png
image/webp
```

### Maximum size

```env
PROOF_OF_DELIVERY_MAX_SIZE_MB=8
```

### Validation errors

| Condition                                     |                    HTTP status |
| --------------------------------------------- | -----------------------------: |
| Invalid delivery ID                           |              `400 Bad Request` |
| Delivery not found                            |                `404 Not Found` |
| Uploader is not assigned driver               |                `403 Forbidden` |
| Delivery already completed/cancelled          |                 `409 Conflict` |
| File exceeds configured limit                 | `413 Request Entity Too Large` |
| Unsupported MIME type                         |   `415 Unsupported Media Type` |
| Missing proof during completion/release guard |     `422 Unprocessable Entity` |

Proof-of-delivery objects are stored under:

```text
proof-of-delivery/<deliveryId>/<originalName>
```

The resulting metadata is attached to the delivery.

---

# Upload Configuration Reference

## Core upload settings

```env
UPLOAD_STORAGE_DRIVER=local
UPLOAD_LOCAL_DIR=uploads
UPLOAD_MAX_FILE_SIZE_MB=10
```

## Profile picture settings

```env
PROFILE_PICTURE_MAX_SIZE_MB=5
PROFILE_PICTURE_WIDTH=500
PROFILE_PICTURE_HEIGHT=500
PROFILE_PICTURE_QUALITY=85
```

## Proof of delivery

```env
PROOF_OF_DELIVERY_MAX_SIZE_MB=8
```

## S3 settings

```env
AWS_S3_BUCKET=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_SIGNED_URL_EXPIRES_SECONDS=3600
```

## Application URL

```env
APP_BASE_URL=http://localhost:3000
```

`APP_BASE_URL` is used when constructing URLs for local storage.

---

# Storage Driver Operational Notes

### Local

Use when:

* Developing locally.
* Running a single instance.
* Persistent local storage is available.

Trade-offs:

* Files are tied to the filesystem.
* Container replacement can remove uploads unless a persistent volume is mounted.
* Multiple application instances require shared storage to see the same files.

### S3

Use when:

* Deploying multiple application instances.
* Durable object storage is required.
* Files should be retrieved through temporary signed URLs.

Trade-offs:

* Requires AWS configuration.
* Uploads depend on S3 availability.
* Signed URLs expire and must be regenerated when required.

---

# Upload Troubleshooting

```text
1. Confirm UPLOAD_STORAGE_DRIVER.
2. For S3, verify AWS_S3_BUCKET and AWS_REGION.
3. Check MIME type against the relevant allow-list.
4. Check the configured size limit.
5. Check [Storage] logs.
6. For profile pictures, inspect Sharp processing errors.
7. For S3, verify credentials or the active IAM role.
8. Verify the returned storage key and driver in persisted metadata.
9. For local storage, verify UPLOAD_LOCAL_DIR and filesystem permissions.
```

Relevant implementation files:

```text
src/services/storage.service.ts
src/services/profilePicture.service.ts
src/services/evidenceService.ts
src/services/proofOfDeliveryService.ts
src/routes/uploadRoutes.ts
src/config/env.ts
```
