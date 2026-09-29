# PR Draft: Fix Notification Preference Identifier Typo

> Draft only. Do not submit until the branch contains the source-code fix and the issue is assigned.

## Summary

Correct the misspelled identifier in the notification device-pruning logic so the condition references the variable declared in the same scope. This resolves the strict TypeScript undefined-variable error without changing runtime behavior.

## Related Issue

Closes #<issue_id>

Replace `<issue_id>` with the assigned issue number before opening a PR. The issue requires assignment before work begins; request assignment and wait for confirmation first.

## Intended Change

- Correct the identifier reference in `src/repositories/NotificationPreferenceRepository.ts` to match its declaration.
- No API, database schema, environment, or architecture changes are required.

## Verification

- `npx pnpm@latest exec tsc --noEmit` — passed with no diagnostics.
- `npx pnpm@latest test -- --runInBand notificationService.test.ts` — passed; 30 tests.

## Proof of Work

Attach a screenshot of the successful TypeScript check or the passing notification test output when opening the PR. No screenshot is included with this draft.

## Submission Checklist

- [ ] Issue is assigned and `<issue_id>` is replaced above.
- [ ] The source file contains an actual diff correcting the identifier.
- [ ] TypeScript check and notification tests pass on the final branch.
- [ ] PR diff contains no unrelated dependency or lockfile changes.
- [ ] Proof-of-work screenshot is attached.

## Current Checkout Note

At the time this draft was created, the target source file already used the identifier consistently, and the branch had no source-file diff relative to `main`. The lockfile was clean. This document alone does not implement the fix and is not ready to submit as a PR.
