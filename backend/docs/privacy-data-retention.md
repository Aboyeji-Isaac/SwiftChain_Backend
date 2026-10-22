# Data Retention and Privacy Reference

## Purpose

This document describes how SwiftChain handles account deletion, restoration, personally identifiable information (PII) in logs, application log retention, evidence records, and audit records.

The implementation currently uses soft deletion for selected business records. Soft deletion should not be interpreted as immediate physical erasure from MongoDB or external storage.

---

## Account and Delivery Deletion

### User records

Users are soft-deleted through `UserService.softDeleteUser()`.

The operation sets:

```text
isDeleted = true
deletedAt = current timestamp
deletedBy = actor ID when supplied
```

The `User` model retains the database document.

User queries normally exclude deleted users:

```ts
{ isDeleted: { $ne: true } }
```

Deleted users can be retrieved through the dedicated deleted-user query used by administrative workflows.

### Driver profiles

When a user has a `DriverProfile`, deleting the user cascades to the driver profile using its `softDelete()` method.

The driver profile receives:

```text
isDeleted = true
deletedAt = current timestamp
deletedBy = actor ID when supplied
```

The driver profile remains in MongoDB.

### Deliveries

Related deliveries are also soft-deleted when a user is deleted.

The cascade covers deliveries where the user is associated as:

* `driverId`
* `userId`
* `sender`
* `recipient`

Each matching delivery is processed through its `softDelete()` method.

The deletion result reports the number of delivery records affected.

### Hard deletion

The inspected user-deletion flow does **not** physically remove the user, driver profile, or related deliveries from MongoDB.

No hard-delete operation is performed by `UserService.softDeleteUser()`.

Historical records may therefore remain available for administrative, audit, operational, or compliance purposes subject to the applicable retention policy.

---

## Restore Behaviour

Users can be restored with `restoreUser()`.

Restoration clears the user's deletion markers:

```text
isDeleted = false
deletedAt = null
deletedBy = undefined
```

Restoring a user does **not** automatically restore the related driver profile or deliveries.

This is intentional because automatically restoring associated operational records could produce an inconsistent application state.

Driver profiles and deliveries therefore require their own restoration workflow where supported.

---

## Password and Sensitive User Fields

The `User` model defines the password field with:

```ts
select: false
```

This prevents passwords from being returned by ordinary Mongoose queries unless explicitly selected.

The password is hashed using bcrypt before persistence.

User JSON serialization also removes the password field.

Applications must never log:

* plaintext passwords
* password hashes
* authentication credentials
* private keys
* service-account credentials
* bearer tokens

---

## PII Logging Protection

Application logging is centralized in:

```text
src/config/logger.ts
```

The logger installs `maskPiiFormat` before downstream transports.

This means PII masking is applied before records reach:

* console output
* rotating log files
* JSON formatting
* additional transports added later

The logger masks both:

1. String messages.
2. Structured metadata.

The logger also masks values stored in Winston's `splat` arguments.

If the masking operation itself fails, the logger fails closed and replaces the record with:

```text
[log record suppressed: PII masking failed]
```

The detailed masking rules are implemented in:

```text
src/utils/piiMasker.ts
```

Developers should therefore continue using the central logger rather than constructing independent logging transports.

---

## Log Storage and Rotation

Log configuration is controlled by the validated environment configuration.

### Configuration

| Variable             | Default | Meaning                        |
| -------------------- | ------- | ------------------------------ |
| `LOG_DIR`            | `logs`  | Directory containing log files |
| `LOG_MAX_SIZE`       | `20m`   | Maximum size before rotation   |
| `LOG_MAX_FILES`      | `14d`   | Retention window               |
| `LOG_ZIPPED_ARCHIVE` | `true`  | Compress rotated files         |
| `LOG_DISABLE_FILE`   | `false` | Disable file logging           |
| `NODE_ENV=test`      | —       | File transports are disabled   |

### Rotation

The logger uses `winston-daily-rotate-file`.

Files:

```text
error-%DATE%.log
all-%DATE%.log
```

Rotation occurs daily and is also bounded by the configured maximum file size.

Old files are compressed when:

```text
LOG_ZIPPED_ARCHIVE=true
```

Files older than the configured `LOG_MAX_FILES` retention window are removed by the rotating-file transport.

The default retention configuration is:

```text
14 days
```

### Disabling file logging

When:

```text
LOG_DISABLE_FILE=true
```

file transports are not created.

File transports are also disabled in the test environment.

Console logging remains available.

---

## Evidence Retention

Delivery-dispute evidence is represented by:

```text
src/models/Evidence.ts
```

Each evidence record contains:

* dispute ID
* uploader ID
* storage driver
* storage key
* secure URL
* original filename
* MIME type
* file size
* creation timestamp
* update timestamp

The current model does not define a MongoDB TTL index or an automatic evidence-expiration mechanism.

The evidence service stores metadata for uploaded evidence, while the actual file may reside in local storage or S3.

### Current retention status

There is currently no documented automatic cleanup period in the inspected `Evidence` model.

Therefore:

```text
Evidence records are retained until an explicit cleanup mechanism is introduced.
```

External object storage cleanup must also be handled explicitly; deleting a MongoDB metadata document does not inherently delete an S3/local object.

---

## Audit Log Retention

Audit records are represented by:

```text
src/models/AuditLog.ts
```

Audit records contain:

* action
* actor
* target type
* target ID
* description
* metadata
* creation timestamp

The current model does not define a TTL index or automatic cleanup period.

Therefore, the current implementation does not establish an automatic audit-log deletion period.

Operations should establish a retention period appropriate to legal, regulatory, security, and business requirements before introducing automatic deletion.

---

## Profile Picture Cleanup Gap

User profiles contain:

```text
profilePicture
profilePictureKey
```

The inspected user soft-delete flow marks the database user as deleted but does not remove the associated profile-picture object from storage.

This means a profile-picture object may remain in local/S3 storage after account deletion.

### Required follow-up

A future cleanup workflow should:

1. Resolve the stored `profilePictureKey`.
2. Delete the object from its configured storage backend.
3. Clear the database references where appropriate.
4. Record the cleanup result for operational/audit purposes.
5. Handle failed storage deletion separately from successful account soft deletion.

Until that workflow exists, profile-picture deletion should be treated as a known privacy/data-retention gap.

---

## Data Retention Policy Template

Operations may adopt the following policy and replace the placeholders with approved organizational values:

> ### SwiftChain Data Retention Policy
>
> SwiftChain retains personal, operational, audit, notification, evidence, and security records only for the period required for service delivery, security, dispute resolution, legal obligations, regulatory requirements, and legitimate operational purposes.
>
> Account deletion uses soft deletion where required to preserve operational and audit integrity. Soft-deleted records are excluded from normal application queries and may be restorable through authorized administrative workflows.
>
> Application logs are protected by centralized PII masking and are rotated according to the configured logging retention period.
>
> Evidence and audit records are retained according to the approved retention schedule. Automatic deletion is performed only where an approved cleanup mechanism exists.
>
> Stored files and external objects must be included in deletion and retention reviews; deleting database metadata does not automatically delete external storage objects.
>
> Retention schedules are reviewed periodically by the appropriate operations, security, legal, and compliance owners.
