# Admin driver search runbook

## Endpoint

GET /api/v1/admin/drivers

Requires a valid Bearer JWT for an account with the admin role. The endpoint searches driver profiles together with public user fields and returns a flattened DTO. Password hashes are excluded from the aggregation projection and response.

## Query parameters

| Parameter | Meaning |
| --- | --- |
| search | Case-insensitive match against first name, last name, combined full name, or email; maximum 100 characters |
| tier | bronze, silver, gold, or platinum |
| minVehicleCapacity | Minimum vehicle capacity in kilograms |
| minReputation / maxReputation | Inclusive reputation-points range |
| availability | available, unavailable, online, offline, or on_delivery |
| minCompletedDeliveries / maxCompletedDeliveries | Inclusive completed-delivery-count range |
| minTotalDeliveries / maxTotalDeliveries | Inclusive total-delivery-count range |
| page | 1-based page number; default 1 |
| limit | Page size; default 20, maximum 100 |
| sort | Comma-separated allow-listed profile fields; prefix a field with - for descending order |

## Example

    curl -G https://api.example.com/api/v1/admin/drivers \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      --data-urlencode "search=ada@example.com" \
      --data-urlencode "tier=gold" \
      --data-urlencode "minVehicleCapacity=500" \
      --data-urlencode "minReputation=100" \
      --data-urlencode "maxReputation=900" \
      --data-urlencode "availability=available" \
      --data-urlencode "minCompletedDeliveries=10" \
      --data-urlencode "page=1" \
      --data-urlencode "limit=20" \
      --data-urlencode "sort=-reputationPoints,createdAt"

The response contains data.drivers and data.meta. The metadata includes totalItems, totalPages, currentPage, limit, hasNextPage, hasPreviousPage, nextPage, and previousPage.

## Operational notes

- Query parameters are parsed by the shared query middleware. Pagination, sorting, and field coercion use the same allow-list rules as other query-enabled routes.
- Search input is treated as literal text, not a regular expression.
- The endpoint joins DriverProfile with User and DriverLocation records in MongoDB; it does not load the full driver population into application memory.
- A driver with no current location record is reported with offline availability and is not considered available for assignment.
- Invalid filter values and inverted minimum/maximum ranges return a 400 response. Missing authentication returns 401; a non-admin role receives 403.


## Index deployment

The DriverProfile schema adds indexes for tier plus reputation points, vehicle capacity, completed deliveries, and total deliveries to support the exposed filters. If production disables Mongoose automatic index creation, create these indexes through the normal database migration/maintenance process before relying on the endpoint. Confirm index build impact and storage cost against the production dataset.
