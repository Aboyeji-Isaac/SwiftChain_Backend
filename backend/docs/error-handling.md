# Error Handling and API Response Conventions

This document explains how errors are created, handled, logged, and returned by the SwiftChain backend.

## Overview

The backend uses a layered architecture: Controller → Service → Repository → Model. Errors raised during request processing are handled centrally by the global error handler and returned using the standard API response envelope.

## Standard API Response Envelope

All JSON API responses use `{ success, data, error, message }`.

### Success

`{ "success": true, "data": <payload>, "error": null, "message": "..." }`

### Error

`{ "success": false, "data": null, "error": "User not found", "message": "User not found" }`

The `data` field contains the successful payload and is `null` for errors. The `error` field is `null` on success. The `message` field contains a human-readable description.

The helpers are implemented in `src/utils/responseWrapper.ts`. `sendSuccess()` defaults to HTTP 200, while `sendError()` defaults to HTTP 500.

## AppError Hierarchy

The runtime `AppError` class is defined in `src/utils/AppError.ts`. It extends JavaScript `Error` and carries an HTTP `statusCode` and an `isOperational` flag.

Constructor:

`new AppError(message, statusCode, isOperational = true)`

The repository also defines specialized error classes in `src/errors/AppError.ts`: NotFound (404), BadRequest (400), Unauthorized (401), Forbidden (403), and Conflict (409). The runtime error handler uses the `AppError` implementation from `src/utils/AppError.ts`.

### Operational errors

`isOperational: true` identifies an expected application failure that can safely be reported to the client, such as a missing resource or invalid request.

### Non-operational errors

Unexpected failures should not expose internal implementation details in production. When `isOperational` is false, the production error handler logs the original error and returns a generic HTTP 500 response.

Example:

`throw new AppError("Authentication required.", 401);`

## Global Error Handler

`src/middleware/errorHandler.ts` normalizes errors before returning them through `sendError()`.

| Error | HTTP status | Handler behavior |
|---|---:|---|
| Mongoose `CastError` | 400 | Returns an invalid-field message |
| MongoDB duplicate key (`11000`) | 400 | Returns a duplicate-field message |
| Mongoose `ValidationError` | 400 | Returns validation messages |
| Zod error | 400 | Returns `Validation failed` |
| `AppError` | Its `statusCode` | Preserves the application error |
| Multer error | 400 | Returns a file-upload error |
| `JsonWebTokenError` | 401 | Returns `Invalid token` |
| `TokenExpiredError` | 401 | Returns `Token has expired` |
| Unknown error | 500 by default | Returns the supplied status/message when available |

The handler also logs the normalized status, message, request URL, HTTP method, and client IP.

## Development and Production Responses

In development and test environments, the handler includes the error stack in the `error` field to make debugging easier while preserving the standard response envelope.

In production, operational errors return their message and status code. Non-operational errors are logged server-side and return a generic HTTP 500 response: `Something went very wrong!`.

Clients should therefore rely on the HTTP status and standard envelope rather than expecting stack traces in production.

## Service Error Example

Services should throw an `AppError` when a business rule or expected failure prevents the requested operation. The global error handler then converts it into the standard response envelope.

Recommended pattern:

`throw new AppError("User not found.", 404);`

A request reaching the error handler would produce an HTTP 404 response such as:

`{ "success": false, "data": null, "error": "User not found.", "message": "User not found." }`

This keeps business-error decisions in the service layer while response formatting remains centralized in the middleware.

## Logging and Practical Guidelines

Use the project `logger` instead of `console.log` or `console.error` for server-side error logging. The global error handler already records the normalized status, message, request URL, method, and client IP.

When adding new service errors:

- Use `AppError` for expected application failures.
- Choose an HTTP status that accurately represents the failure.
- Keep client-facing messages clear and safe.
- Do not expose credentials, stack traces, database details, or other infrastructure-sensitive information in production responses.
- Let the global error handler format the response instead of constructing ad-hoc error envelopes in services or controllers.
