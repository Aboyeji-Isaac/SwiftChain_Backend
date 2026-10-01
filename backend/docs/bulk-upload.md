# Bulk Delivery CSV Upload Reference

## Endpoint

```http
POST /api/v1/deliveries/bulk
```

Authentication is required.

The request must use `multipart/form-data` with exactly one CSV file under the `file` field.

```bash
curl -X POST "http://localhost:3000/api/v1/deliveries/bulk" \
  -H "Authorization: Bearer <JWT>" \
  -F "file=@deliveries.csv"
```

## CSV Format

The parser normalizes column names to lowercase, so the following headers are accepted:

### Required columns

```csv
trackingNumber,customerName,customerPhone,pickupAddress,dropoffAddress,packageDescription,packageWeight,deliveryFee,escrowAmount
```

| Column               | Type   | Rules                       |
| -------------------- | ------ | --------------------------- |
| `trackingNumber`     | string | Required, non-empty, unique |
| `customerName`       | string | Required, non-empty         |
| `customerPhone`      | string | Required, non-empty         |
| `customerEmail`      | email  | Optional                    |
| `pickupAddress`      | string | Required, non-empty         |
| `dropoffAddress`     | string | Required, non-empty         |
| `packageDescription` | string | Required, non-empty         |
| `packageWeight`      | number | Required, greater than `0`  |
| `deliveryFee`        | number | Required, `>= 0`            |
| `escrowAmount`       | number | Required, `>= 0`            |
| `notes`              | string | Optional                    |

Numeric values are parsed from CSV strings.

## Example CSV

Save the following as `deliveries.csv`:

```csv
trackingNumber,customerName,customerPhone,customerEmail,pickupAddress,dropoffAddress,packageDescription,packageWeight,deliveryFee,escrowAmount,notes
SWIFT-10001,Ada Example,+2348012345678,ada@example.com,"12 Marina Road, Lagos","25 Admiralty Way, Lagos","Documents",1.5,2500,10000,"Handle with care"
SWIFT-10002,John Example,+2348098765432,john@example.com,"10 Ikeja Road, Lagos","4 Allen Avenue, Lagos","Electronics",3,5000,20000,""
```

## Upload Limits

The following environment variables control the import limits:

```env
BULK_UPLOAD_MAX_BYTES=5242880
BULK_UPLOAD_MAX_ROWS=1000
```

Defaults:

* `BULK_UPLOAD_MAX_BYTES`: `5 MB`
* `BULK_UPLOAD_MAX_ROWS`: `1000` data rows
* `BULK_UPLOAD_MAX_BYTES` must be at least `1024` bytes.
* `BULK_UPLOAD_MAX_ROWS` accepts values from `1` through `10000`.

An oversized multipart upload is rejected by Multer with HTTP `413`.

A CSV exceeding the configured row limit is rejected as an invalid CSV request with HTTP `400`.

## Validation

Rows are validated independently.

For an invalid row, the service reports each invalid field rather than stopping at the first error.

Example:

```json
{
  "line": 4,
  "trackingNumber": "SWIFT-10004",
  "field": "packageweight",
  "message": "packageWeight must be greater than zero"
}
```

The `line` value is the 1-based CSV line number.

## Duplicate Handling

`trackingNumber` is the deduplication key.

Duplicates are handled at two levels:

1. Duplicate tracking numbers inside the same CSV are rejected.
2. Tracking numbers already present in the database are skipped and reported as row errors.

Example:

```json
{
  "line": 7,
  "trackingNumber": "SWIFT-10001",
  "field": "trackingNumber",
  "message": "A delivery with this tracking number already exists"
}
```

The service resolves existing tracking numbers in a single lookup before insertion.

Valid, non-duplicate rows continue to be inserted.

## Partial Batch Inserts

Validated rows are inserted using unordered bulk insertion:

```ts
createMany(documents, { ordered: false })
```

A database failure for one row therefore does not automatically discard other valid rows.

Database write errors are mapped back to their original CSV line.

## Response Statuses

### `201 Created`

All valid rows were imported successfully.

```json
{
  "status": "success",
  "message": "Imported 2 deliveries",
  "data": {
    "totalRows": 2,
    "successCount": 2,
    "failureCount": 0,
    "created": ["SWIFT-10001", "SWIFT-10002"],
    "errors": []
  }
}
```

### `207 Multi-Status`

At least one row succeeded and at least one row failed.

```json
{
  "status": "partial",
  "message": "Imported 1 of 2 deliveries",
  "data": {
    "totalRows": 2,
    "successCount": 1,
    "failureCount": 1,
    "created": ["SWIFT-10001"],
    "errors": [
      {
        "line": 3,
        "trackingNumber": "SWIFT-10002",
        "field": "customerEmail",
        "message": "customerEmail must be a valid email address"
      }
    ]
  }
}
```

### `400 Bad Request`

Returned when the CSV itself is unusable, including:

* Missing required columns
* Empty/unparseable CSV
* CSV parser errors
* Exceeding the configured row limit
* Invalid file type
* Missing upload

### `413 Payload Too Large`

Returned when the uploaded file exceeds `BULK_UPLOAD_MAX_BYTES`.

### `422 Unprocessable Entity`

Returned when the CSV is structurally valid but **no delivery can be created**.

## Error Object

Each row error has the following structure:

```ts
interface BulkRowError {
  line: number;
  trackingNumber?: string;
  field?: string;
  message: string;
}
```

`failureCount` counts rejected rows, not individual validation messages. A single row with multiple invalid fields counts as one failed row.

## Implementation References

```text
src/routes/bulkDeliveryRoutes.ts
src/controllers/bulkDeliveryController.ts
src/services/bulkDeliveryService.ts
src/config/env.ts
tests/bulkDeliveryService.test.ts
tests/csvParser.test.ts
```

> **Implementation note:** The current backend returns `207 Multi-Status` for partial success and `422` when zero rows can be imported. The documentation reflects the implemented API behavior rather than the original issue wording that described partial success as `201`.
