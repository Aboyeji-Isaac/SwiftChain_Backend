# Fleet and Invitations Workflow

## Base URL

```text
/api/v1/fleets
```

All fleet endpoints require authentication.

Enterprise-only administration routes additionally require the `ENTERPRISE` role.

## Fleet Model

```ts
{
  name: string,
  treasuryAddress: string,
  ownerId: ObjectId,
  members: [
    {
      userId: ObjectId,
      role: "admin" | "driver" | "viewer",
      joinedAt: Date
    }
  ],
  businessMetadata: {
    companyName: string,
    industry?: string,
    registrationNumber?: string,
    vatNumber?: string,
    address?: {
      street?: string,
      city?: string,
      country?: string,
      postalCode?: string
    },
    contactEmail: string,
    contactPhone?: string,
    website?: string
  },
  isActive: boolean
}
```

## Treasury Address

Fleet treasury addresses must match the Stellar public-key format:

```regex
^G[A-Z0-9]{55}$
```

The address must:

* Start with `G`
* Contain exactly 56 characters
* Contain only uppercase letters and digits after the initial `G`

Example:

```json
{
  "treasuryAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

## Member Roles

Fleet members can have one of:

```text
admin
driver
viewer
```

The fleet owner is automatically added as an `admin`.

The model also exposes a `driverIds` virtual containing members whose roles are `driver` or `admin`.

## Owner Auto-Join

New fleets ensure the owner exists in `members`.

The model pre-save hook adds:

```ts
{
  userId: ownerId,
  role: "admin",
  joinedAt: new Date()
}
```

when the owner is not already present.

## Authorization

| Operation             | Required access    |
| --------------------- | ------------------ |
| Create fleet          | Enterprise         |
| List fleets           | Enterprise         |
| Get fleet             | Authenticated      |
| Update fleet          | Enterprise + owner |
| Delete fleet          | Enterprise + owner |
| Add member            | Enterprise + owner |
| Remove member         | Enterprise + owner |
| Invite driver         | Enterprise + owner |
| Respond to invitation | Driver             |
| Fleet metrics         | Enterprise + owner |

All routes are authenticated through the fleet router.

## Create Fleet

```http
POST /api/v1/fleets
```

Example:

```bash
curl -X POST "http://localhost:3000/api/v1/fleets" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Swift Lagos Fleet",
    "treasuryAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "businessMetadata": {
      "companyName": "Swift Logistics Ltd",
      "industry": "Logistics",
      "registrationNumber": "RC123456",
      "vatNumber": "VAT123456",
      "address": {
        "street": "12 Marina Road",
        "city": "Lagos",
        "country": "Nigeria",
        "postalCode": "101001"
      },
      "contactEmail": "fleet@example.com",
      "contactPhone": "+2348000000000",
      "website": "https://example.com"
    }
  }'
```

Returns `201 Created` on success.

## List Fleets

```http
GET /api/v1/fleets
```

Optional query parameters:

```text
page
limit
```

Example:

```bash
curl "http://localhost:3000/api/v1/fleets?page=1&limit=10" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>"
```

The response includes:

```json
{
  "fleets": [],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 0,
    "pages": 0
  }
}
```

Only active fleets are listed.

## Get Fleet

```http
GET /api/v1/fleets/:id
```

Example:

```bash
curl "http://localhost:3000/api/v1/fleets/<FLEET_ID>" \
  -H "Authorization: Bearer <JWT>"
```

The response includes populated owner and member information.

## Update Fleet

```http
PUT /api/v1/fleets/:id
```

Example:

```bash
curl -X PUT "http://localhost:3000/api/v1/fleets/<FLEET_ID>" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Lagos Fleet",
    "businessMetadata": {
      "companyName": "Updated Logistics Ltd",
      "contactEmail": "ops@example.com"
    }
  }'
```

The owner cannot be changed through this endpoint.

The following fields are protected from update:

```text
ownerId
_id
createdAt
members
```

## Delete Fleet

Fleet deletion is a soft delete.

```http
DELETE /api/v1/fleets/:id
```

Example:

```bash
curl -X DELETE "http://localhost:3000/api/v1/fleets/<FLEET_ID>" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>"
```

The fleet's:

```ts
isActive
```

value is changed to `false`.

## Add Member

```http
POST /api/v1/fleets/:id/members
```

Example:

```bash
curl -X POST "http://localhost:3000/api/v1/fleets/<FLEET_ID>/members" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "<USER_ID>",
    "role": "driver"
  }'
```

Supported roles:

```text
admin
driver
viewer
```

The fleet owner cannot add a duplicate member.

## Remove Member

```http
DELETE /api/v1/fleets/:id/members/:userId
```

Example:

```bash
curl -X DELETE "http://localhost:3000/api/v1/fleets/<FLEET_ID>/members/<USER_ID>" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>"
```

The fleet owner cannot remove themselves.

## Invite Driver

```http
POST /api/v1/fleets/:id/invite
```

Example:

```bash
curl -X POST "http://localhost:3000/api/v1/fleets/<FLEET_ID>/invite" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "<DRIVER_ID>"
  }'
```

Only the fleet owner can create invitations.

The target user must:

* Exist
* Have the `DRIVER` role
* Not already be a fleet member
* Not already have a pending invitation for the fleet

## Invitation Lifecycle

```text
create
  ↓
pending
  ├── accept → accepted
  └── decline → declined
```

An invitation contains:

```ts
{
  fleetId: ObjectId,
  driverId: ObjectId,
  invitedBy: ObjectId,
  status: "pending" | "accepted" | "declined",
  respondedAt?: Date
}
```

A partial unique index prevents multiple pending invitations for the same fleet and driver:

```js
db.fleetinvitations.createIndex(
  {
    fleetId: 1,
    driverId: 1,
    status: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      status: "pending"
    }
  }
)
```

## Respond to Invitation

```http
PATCH /api/v1/fleets/invitations/:invitationId
```

Example:

```bash
curl -X PATCH "http://localhost:3000/api/v1/fleets/invitations/<INVITATION_ID>" \
  -H "Authorization: Bearer <DRIVER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "accept": true
  }'
```

Declining:

```json
{
  "accept": false
}
```

Only the invited driver can respond.

When accepted, the driver is added to the fleet's legacy `drivers` array.

An invitation that is no longer pending cannot be responded to again.

## Fleet Metrics

```http
GET /api/v1/fleets/:id/metrics
```

Example:

```bash
curl "http://localhost:3000/api/v1/fleets/<FLEET_ID>/metrics" \
  -H "Authorization: Bearer <ENTERPRISE_JWT>"
```

Only the fleet owner can access metrics.

The response aggregates:

```ts
{
  fleetId: string,
  driverCount: number,
  totalDeliveries: number,
  completedDeliveries: number,
  totalEscrowValue: number,
  totalEscrowValueAsset: "XLM"
}
```

`totalEscrowValue` only includes deliveries whose escrow asset is XLM. Other assets are excluded from this legacy metric.

## Fleet Indexes

The fleet collection defines:

```js
{ ownerId: 1 }
{ "members.userId": 1 }
{ treasuryAddress: 1 } // unique
```

Fleet invitations define:

```js
{ fleetId: 1, driverId: 1, status: 1 } // unique pending
{ driverId: 1 }
```

## Implementation References

```text
src/routes/fleetRoutes.ts
src/controllers/fleetController.ts
src/services/fleetService.ts
src/models/Fleet.ts
src/models/FleetInvitation.ts
tests/fleet.test.ts
```
