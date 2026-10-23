import http from 'k6/http';
import { check } from 'k6';
import { API_PREFIX } from './config.js';

/**
 * Service-layer helper: authenticates against the real
 * `POST /api/v1/auth/login` endpoint and returns a bearer token.
 *
 * Kept separate from scenario files so scenarios (the "controller" layer of
 * this suite) stay focused on describing traffic shape, not HTTP plumbing.
 */
export function login(email, password) {
  const res = http.post(`${API_PREFIX}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'AuthLogin' },
  });

  check(res, {
    'login status is 200': (r) => r.status === 200,
    'login returns a token': (r) => {
      try {
        return typeof r.json('data.token') === 'string' && r.json('data.token').length > 0;
      } catch {
        return false;
      }
    },
  });

  if (res.status !== 200) {
    return null;
  }

  return res.json('data.token');
}

export function authHeaders(token) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
}
