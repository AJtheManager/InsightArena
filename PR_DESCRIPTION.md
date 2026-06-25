# Backend Bug Fixes and Feature Enhancements

## Overview

This PR addresses 4 critical bugs and adds a highly requested authentication feature to improve the InsightArena backend API's reliability, performance, and user experience.

Closes #1076  
Closes #1079  
Closes #1075  
Closes #1080

---

## Changes

### 🐛 Task 1: Fix PredictionsService.claim - Persist payout_amount_stroops (#1076)

**Problem:**  
`PredictionsService.claim()` was calling `sorobanService.claimPayout()` but never storing the returned payout amount. The `payout_amount_stroops` field remained at `'0'` in the database, causing `GET /predictions/:id` to always show zero for claimed predictions.

**Solution:**
- Updated `SorobanPredictionResult` interface to include optional `payout_amount_stroops?: string`
- Modified `SorobanService.claimPayout()` to return payout amount in response (stub returns `'15000000'` for development)
- Updated `PredictionsService.claim()` to extract and persist `payout_amount_stroops` from the Soroban response
- Added comprehensive test coverage to verify payout persistence

**Files Changed:**
- `src/soroban/soroban.service.ts` - Added payout_amount_stroops to return type and implementation
- `src/predictions/predictions.service.ts` - Extract and persist payout amount from Soroban response
- `src/predictions/predictions.service.spec.ts` - Added test for payout amount persistence

**Acceptance Criteria Met:**
- ✅ `payout_amount_stroops` is non-zero for successfully claimed winning predictions
- ✅ `ConflictException` thrown on double-claim attempts
- ✅ Comprehensive test coverage added

---

### 🐛 Task 2: Fix AuthService Memory Leak - Periodic Challenge Cache Cleanup (#1079)

**Problem:**  
`AuthService.challengeCache` was an in-memory `Map` with `cleanupExpiredChallenges()` only called inside `generateChallenge()`. In read-heavy scenarios with many `verifySignature()` calls and few `generateChallenge()` calls, expired entries would accumulate indefinitely, causing a memory leak. Additionally, the in-memory cache doesn't work across multiple instances in distributed deployments.

**Solution:**
- Implemented `@Cron('*/5 * * * *')` decorator on `cleanupExpiredChallenges()` for automatic cleanup every 5 minutes
- Made `AuthService` implement `OnModuleInit` for initialization logging
- Removed manual cleanup call from `generateChallenge()` since periodic cleanup handles it
- Made cleanup method public for testability
- Added comprehensive test coverage for periodic cleanup behavior

**Files Changed:**
- `src/auth/auth.service.ts` - Added `@Cron` decorator, `OnModuleInit`, and periodic cleanup
- `src/auth/auth.service.spec.ts` - Added tests for periodic cleanup functionality

**Acceptance Criteria Met:**
- ✅ Expired entries removed by periodic cleanup (every 5 minutes) without waiting for `generateChallenge()`
- ✅ Cleanup method is public and testable
- ✅ Memory leak prevented under read-heavy load scenarios

**Note:** `ScheduleModule` was already imported in `app.module.ts`, so no additional dependencies were required.

---

### 🐛 Task 3: Fix PredictionsService.findMine - Move Status Filter to Database Query (#1075)

**Problem:**  
`PredictionsService.findMine()` was fetching a page of predictions with SQL `skip/take`, then filtering by `status` in-memory. This meant a request for `limit=20` with `status=Won` could return fewer than 20 items even when 100+ winning predictions existed in the database. The `total` count was also incorrect, and pagination was broken.

**Solution:**
- Moved status filter logic from in-memory `.filter()` to SQL `QueryBuilder.andWhere()` clauses
- Added database-level filtering for all four status types:
  - **Active**: `is_resolved = false AND is_cancelled = false`
  - **Won**: `is_resolved = true AND is_cancelled = false AND resolved_outcome = chosen_outcome`
  - **Lost**: `is_resolved = true AND is_cancelled = false AND resolved_outcome != chosen_outcome`
  - **Pending**: `is_cancelled = true`
- Removed in-memory filtering completely
- Added comprehensive test coverage with mocked QueryBuilder

**Files Changed:**
- `src/predictions/predictions.service.ts` - Moved status filtering to database query level
- `src/predictions/predictions.service.spec.ts` - Added extensive test coverage for all status filters

**Acceptance Criteria Met:**
- ✅ `total` reflects true DB count for the given filter
- ✅ No in-memory filtering after `getManyAndCount()`
- ✅ Accurate pagination with correct item counts per page
- ✅ All four status filters work correctly at the SQL level

---

### ✨ Task 4: Feature - Add POST /auth/refresh JWT Token Refresh Endpoint (#1080)

**Problem:**  
JWTs issued by `POST /auth/verify` expire after `JWT_EXPIRES_IN` with no refresh mechanism. Users had to complete the full challenge → sign → verify flow on every token expiry, creating poor UX for long-running sessions and making automated agents impossible.

**Solution:**
- Added `AuthService.refreshToken(userId)` method that:
  - Validates user still exists in database
  - Throws `UnauthorizedException` if user is deleted
  - Issues new JWT with fresh expiry using same payload structure
- Added `POST /auth/refresh` protected endpoint in `AuthController`:
  - Requires valid JWT (protected by `@ApiBearerAuth()`)
  - Returns new `access_token` and `expires_at` timestamp
  - Calculates expiry based on `JWT_EXPIRES_IN` environment variable
- Created `RefreshTokenResponseDto` for type safety and Swagger documentation
- Added comprehensive test coverage for both service and controller

**Files Changed:**
- `src/auth/dto/refresh-token.dto.ts` - New DTO for refresh response
- `src/auth/auth.service.ts` - Added `refreshToken()` method
- `src/auth/auth.controller.ts` - Added `POST /auth/refresh` endpoint with expiry calculation
- `src/auth/auth.service.spec.ts` - Added tests for token refresh logic
- `src/auth/auth.controller.spec.ts` - Added tests for refresh endpoint

**API Endpoint:**
```http
POST /api/v1/auth/refresh
Authorization: Bearer <valid_jwt>

Response 200:
{
  "access_token": "eyJhbGci...",
  "expires_at": "2026-07-25T12:00:00.000Z"
}

Response 401: User deleted or invalid token
```

**Acceptance Criteria Met:**
- ✅ Valid JWT holders get a new token without re-signing
- ✅ Deleted users cannot refresh (throws `UnauthorizedException`)
- ✅ Protected endpoint requires authentication
- ✅ Returns both token and expiry timestamp
- ✅ Comprehensive test coverage

---

## Testing

All changes include comprehensive unit tests:

**Test Coverage:**
- ✅ Task 1: Payout persistence and double-claim prevention
- ✅ Task 2: Periodic cleanup execution and expired entry removal
- ✅ Task 3: Database-level filtering for all status types
- ✅ Task 4: Token refresh for valid users and rejection for deleted users

**Run Tests:**
```bash
cd backend
pnpm test
```

---

## Breaking Changes

None. All changes are backward compatible.

---

## Migration Notes

No database migrations required. All changes are application-level only.

---

## Configuration

### Task 2 - Periodic Cleanup
The challenge cache cleanup runs automatically every 5 minutes via `@Cron('*/5 * * * *')`. No configuration needed.

### Task 4 - Token Refresh
The refresh endpoint uses the existing `JWT_EXPIRES_IN` and `JWT_SECRET` environment variables. No new configuration required.

---

## Performance Impact

- **Task 2**: Reduces memory usage under high load by preventing cache accumulation
- **Task 3**: Improves query performance by filtering at database level instead of in-memory
- **Task 4**: Reduces authentication overhead by eliminating repeated challenge/sign flows

---

## Security Considerations

- **Task 1**: Payout amounts are now accurately tracked for audit purposes
- **Task 2**: Expired challenges are automatically cleaned up, reducing attack surface
- **Task 4**: Refresh tokens still require valid authentication; deleted users cannot refresh

---

## Future Improvements

- **Task 2**: Consider migrating challenge cache to Redis for multi-instance support
- **Task 4**: Consider implementing refresh token rotation for enhanced security

---

## Checklist

- [x] Code follows project style guidelines
- [x] All tests pass locally
- [x] New tests added for all changes
- [x] No breaking changes introduced
- [x] Documentation updated where necessary
- [x] PR description clearly explains changes
