import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  API_PREFIX,
  drivers,
  customers,
  SHARED_PASSWORD,
  defaultThresholds,
  defaultStages,
} from '../lib/config.js';
import { login } from '../lib/authClient.js';

/**
 * Load test for the authentication surface:
 *   - POST /api/v1/auth/login   (existing seeded accounts — the hot path)
 *   - POST /api/v1/auth/register (new-account path, one unique user per run)
 *
 * All login traffic exercises accounts created by `npm run seed`, which
 * inserts real documents into MongoDB via the application's User model.
 * No credentials are hardcoded here.
 */
export const options = {
  stages: defaultStages,
  thresholds: defaultThresholds,
};

const accounts = [...drivers, ...customers];

// One process-wide timestamp so repeated runs never collide on the
// registration email, without hardcoding a fixed test address.
export function setup() {
  return { runId: Date.now() };
}

export default function (data) {
  const account = accounts[(__VU + __ITER) % accounts.length];

  const token = login(account.email, SHARED_PASSWORD);
  check(token, { 'received a usable JWT': (t) => !!t });

  sleep(1);

  // Exercise the registration path at a lower rate (roughly 1 in 20
  // iterations) so it's represented in the load profile without flooding
  // the database with throwaway accounts on every iteration.
  if (__ITER % 20 === 0) {
    const email = `loadtest.register.${data.runId}.${__VU}.${__ITER}@swiftchain.test`;
    const res = http.post(
      `${API_PREFIX}/auth/register`,
      JSON.stringify({
        firstName: 'Load',
        lastName: 'Tester',
        email,
        password: SHARED_PASSWORD,
      }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'AuthRegister' } },
    );

    check(res, {
      'register status is 201': (r) => r.status === 201,
    });
  }

  sleep(1);
}
