# Shared Query Contract

All list endpoints expose a single, consistent query interface backed by
`buildQueryOptions` (`src/middlewares/queryMiddleware.ts`). This document is
the contract clients can rely on.

## Parameters

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `page`    | positive integer | `1` | 1-based page number. |
| `limit`   | positive integer | route default (10/20) | Page size, clamped to the route's `maxLimit` (100 by default). |
| `sort`    | comma-separated string | route default (`-createdAt`) | e.g. `sort=-createdAt,name`. Leading `-` = descending. Fields outside the route's whitelist are rejected with 400. |
| `search`  | string | — | Free-text match against the route's `searchableFields` (case-insensitive, literal substring). |
| `<field>` | route-declared type | — | Direct equality filter, e.g. `?status=pending`. Only whitelisted fields are accepted. |
| `<field>[op]` | — | — | Comparison filter where `op` ∈ `eq, ne, gt, gte, lt, lte, in, nin`, e.g. `?createdAt[gte]=2026-01-01` or `?status[in]=pending,assigned`. Non-whitelisted operators/fields are rejected with 400. |

## Pagination metadata

Every paginated list response returns the same meta shape (inside the
response's `data`, alongside the collection):

```json
{
  "totalItems": 42,
  "totalPages": 5,
  "currentPage": 1,
  "limit": 10,
  "hasNextPage": true,
  "hasPreviousPage": false,
  "nextPage": 2,
  "previousPage": null
}
```

Built by `buildPaginationMeta(totalItems, page, limit)`.

## Notes

- Invalid `page`/`limit`/`sort`/filter values produce a 400 with a descriptive
  message — they are never silently coerced or ignored.
- Unknown query-string fields are ignored, so adding new whitelisted fields
  later is backward compatible.
- Errors surface through the global error handler in the standard envelope
  (`success: false`, `error` populated).

## Endpoint configuration

| Endpoint | Filterable fields | Searchable | Sortable |
| -------- | ----------------- | ---------- | -------- |
| `GET /v1/deliveries` | `status`, `driver` | `trackingNumber`, `customer.name`, `customer.phone` | `createdAt` |
| `GET /v1/deliveries/archived` | — | — | `createdAt` |
| `GET /v1/users/deleted` | `role`, `status` | `email`, `firstName`, `lastName` | `deletedAt` |
| `GET /v1/disputes` | `status`, `reason`, `raisedBy`, `deliveryId` | — | `createdAt` |
| `GET /v1/fleets` | `isActive` | `name` | `createdAt` |
| `GET /v1/notifications` | `status`, `event` | — | `createdAt` |
| `GET /v1/webhooks` | `isActive` | — | `createdAt` |
| `GET /v1/eventlog/unprocessed` | — | — | `createdAt` |
