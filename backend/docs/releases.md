# Release, Versioning, and Changelog Process

## Purpose

This document defines how SwiftChain Backend changes are grouped into releases, versioned, documented, tagged, deployed, and communicated.

The repository currently declares its package version in:

```text
package.json
```

Current release conventions should be applied consistently with the existing `main` and `develop` workflow.

---

## 1. Semantic Versioning

SwiftChain Backend follows:

```text
MAJOR.MINOR.PATCH
```

### MAJOR

Increment MAJOR for backwards-incompatible API or contract changes.

Examples:

* Removing a supported endpoint.
* Removing or renaming a required response field.
* Changing an API contract in a way that breaks existing clients.
* Removing a supported model or integration contract.

Example:

```text
1.4.2 → 2.0.0
```

### MINOR

Increment MINOR for backwards-compatible functionality.

Examples:

* Adding a new endpoint.
* Adding an optional request parameter.
* Adding a new non-breaking integration.
* Adding a new optional response field.

Example:

```text
1.4.2 → 1.5.0
```

### PATCH

Increment PATCH for backwards-compatible fixes.

Examples:

* Bug fixes.
* Security fixes that do not change the public contract.
* Documentation-only changes when the release process includes them.
* Internal performance improvements without contract changes.

Example:

```text
1.4.2 → 1.4.3
```

---

## 2. Changelog

Maintain release history in:

```text
CHANGELOG.md
```

Each release should include:

```markdown
## [1.5.0] - YYYY-MM-DD

### Added
- New functionality.

### Changed
- Backwards-compatible changes.

### Fixed
- Bug fixes.

### Deprecated
- Features scheduled for removal.

### Removed
- Features removed in this release.

### Security
- Security-related changes.
```

Only include categories that contain actual changes.

---

## 3. PR Labels and Changelog Entries

PR labels should communicate the release impact.

Suggested mapping:

| PR label      | Changelog category | Version impact                            |
| ------------- | ------------------ | ----------------------------------------- |
| `breaking`    | Removed / Changed  | MAJOR                                     |
| `feature`     | Added              | MINOR                                     |
| `enhancement` | Changed            | MINOR                                     |
| `bug` / `fix` | Fixed              | PATCH                                     |
| `security`    | Security           | PATCH unless breaking                     |
| `deprecation` | Deprecated         | Usually MINOR                             |
| `docs`        | Documentation      | No API version impact by default          |
| `refactor`    | Changed/internal   | No version impact unless contract changes |

The final release version is determined from the merged changes, not from the label alone.

---

## 4. Release Checklist

### Before release

* [ ] Review all merged PRs since the previous release.
* [ ] Confirm semantic-version impact.
* [ ] Update `CHANGELOG.md`.
* [ ] Confirm required database migrations.
* [ ] Confirm rollback procedures.
* [ ] Confirm deprecated features are documented.
* [ ] Confirm environment configuration changes.
* [ ] Run lint.
* [ ] Run build.
* [ ] Run tests.
* [ ] Run coverage.
* [ ] Review the final Git diff.

### Validation commands

```bash
pnpm run lint
pnpm run build
pnpm test
pnpm run test:coverage
```

### Database

Before deployment:

```text
Review migration
    ↓
Backup database
    ↓
Run dry run
    ↓
Apply migration
    ↓
Verify data parity
    ↓
Verify indexes
```

### Deployment

```text
Prepare release
    ↓
Create release branch
    ↓
Run CI
    ↓
Create version/tag
    ↓
Deploy
    ↓
Run health check
    ↓
Monitor logs and metrics
```

---

## 5. Branch and Tag Conventions

### Feature branches

Use the existing repository convention:

```text
feat/<short-description>
```

### Bug fixes

```text
fix/<short-description>
```

### Documentation

```text
docs/<short-description>
```

### Release branches

Use:

```text
release/v<version>
```

Example:

```text
release/v1.5.0
```

### Release tags

Create annotated tags:

```bash
git tag -a v1.5.0 -m "Release v1.5.0"
git push origin v1.5.0
```

### Hotfixes

Create hotfix branches from the production release line:

```text
hotfix/<short-description>
```

After validation:

```text
hotfix → main
hotfix → develop
```

Ensure the changelog and version are updated consistently in both branches.

---

## 6. Worked Release Example

Assume the merged changes contain:

```text
PR A: Add delivery search endpoint
PR B: Fix escrow timeout
PR C: Improve delivery documentation
```

Release impact:

```text
PR A → MINOR
PR B → PATCH
PR C → Documentation
```

The release therefore requires a MINOR version increment.

If the previous release was:

```text
1.4.2
```

the release becomes:

```text
1.5.0
```

Update `CHANGELOG.md`:

```markdown
## [1.5.0] - YYYY-MM-DD

### Added
- Added delivery search functionality.

### Fixed
- Corrected escrow timeout handling.

### Documentation
- Updated delivery documentation.
```

Create:

```bash
git checkout main
git pull origin main

git checkout -b release/v1.5.0

# Update package version and CHANGELOG.md

pnpm run lint
pnpm run build
pnpm test
pnpm run test:coverage

git add package.json CHANGELOG.md
git commit -m "chore(release): prepare v1.5.0"

git tag -a v1.5.0 -m "Release v1.5.0"
git push origin release/v1.5.0
git push origin v1.5.0
```

After deployment, perform the health check and monitor application logs.

---

## 7. Deprecation Policy

Deprecated endpoints and models must be announced before removal.

A deprecation should document:

* affected endpoint/model
* current version
* replacement endpoint/model
* reason for deprecation
* migration instructions
* planned removal version
* relevant changelog entry

Example:

```markdown
### Deprecated

`GET /api/v1/legacy-deliveries`

Use:

`GET /api/v1/deliveries`

The legacy endpoint remains available for the documented deprecation period and is
scheduled for removal in the next major API version.
```

Do not remove a documented public endpoint solely because a replacement exists.

---

## 8. Release Verification

After deployment:

* [ ] Deployment completed successfully.
* [ ] Health endpoint responds successfully.
* [ ] Database connectivity is healthy.
* [ ] Redis connectivity is healthy where enabled.
* [ ] Stellar/Soroban connectivity is healthy where enabled.
* [ ] Background jobs are running as expected.
* [ ] No migration errors are present.
* [ ] Error rate is normal.
* [ ] Release tag points to the deployed commit.
* [ ] Changelog matches the release.
* [ ] Deprecated functionality is behaving according to the documented policy.
