import express from 'express';
import type { Router } from 'express';
import routes from '../src/routes';
import swaggerSpec from '../src/docs/swagger';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── Express router introspection ─────────────────────────────────────────────

interface LayerLike {
  name?: string;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
  regexp?: RegExp;
  handle?: { stack?: LayerLike[] };
}

interface OpenApiSpec {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; responses?: Record<string, unknown> };
  tags?: Array<{ name: string }>;
}

const spec = swaggerSpec as OpenApiSpec;

/** Decode the mount path out of an Express layer's compiled regexp. */
const decodeMountPath = (regexp: RegExp): string => {
  let source = regexp.source.replace(/^\^/, '').split('\\/').join('/');
  const paramStart = source.indexOf('/?(');
  if (paramStart !== -1) source = source.slice(0, paramStart);
  return source;
};

/** Convert an Express path (`/:id/rating`) into an OpenAPI path (`/{id}/rating`). */
const toOpenApiPath = (prefix: string, routePath: string): string => {
  const full = routePath === '/' ? prefix : `${prefix}${routePath}`;
  return full.replace(/:[A-Za-z0-9_]+/g, (token) => `{${token.slice(1)}}`);
};

/** Recursively walk the router tree and collect `METHOD path` pairs. */
const collectRoutes = (
  router: { stack?: LayerLike[] },
  prefix: string,
  acc: Array<{ method: string; path: string }>,
): void => {
  const layers = router.stack ?? [];

  for (const layer of layers) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).filter(
        (method) => layer.route?.methods[method],
      );

      for (const routePath of paths) {
        for (const method of methods) {
          acc.push({ method: method.toLowerCase(), path: toOpenApiPath(prefix, routePath) });
        }
      }
      continue;
    }

    if (layer.handle && Array.isArray(layer.handle.stack) && layer.regexp) {
      collectRoutes(layer.handle, `${prefix}${decodeMountPath(layer.regexp)}`, acc);
    }
  }
};

const collectMountedRoutes = (): Array<{ method: string; path: string }> => {
  const app = express();
  app.use('/api', routes as unknown as Router);
  const acc: Array<{ method: string; path: string }> = [];
  const appRouter = (app as unknown as { _router: { stack: LayerLike[] } })._router;
  collectRoutes(appRouter, '', acc);

  return acc
    .map((route) => ({ ...route, path: route.path.replace(/^\/api/, '') }))
    .filter((route) => route.path.startsWith('/v1'));
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpenAPI specification', () => {
  it('declares OpenAPI 3.0.3', () => {
    expect(spec.openapi).toBe('3.0.3');
  });

  it('documents every route mounted from src/routes/index.ts', () => {
    const mounted = collectMountedRoutes();
    expect(mounted.length).toBeGreaterThan(50);

    const missing = mounted.filter((route) => {
      const pathItem = spec.paths[route.path];
      return !pathItem || typeof pathItem[route.method] !== 'object';
    });

    expect(missing).toEqual([]);
  });

  it('declares a tag for every tag used by an operation', () => {
    const declared = new Set((spec.tags ?? []).map((tag) => tag.name));
    const used = new Set<string>();

    for (const pathItem of Object.values(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const tags = (operation as { tags?: string[] }).tags ?? [];
        tags.forEach((tag) => used.add(tag));
      }
    }

    const undeclared = [...used].filter((tag) => !declared.has(tag));
    expect(undeclared).toEqual([]);
  });

  it('has no dangling $ref targets', () => {
    const refs = new Set<string>();

    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/')) {
          refs.add(record.$ref);
        }
        Object.values(record).forEach(walk);
      }
    };

    walk(spec);

    const resolve = (ref: string): boolean => {
      const parts = ref.replace('#/', '').split('/');
      let current: unknown = spec;
      for (const part of parts) {
        if (!current || typeof current !== 'object') return false;
        current = (current as Record<string, unknown>)[part];
      }
      return current !== undefined;
    };

    const dangling = [...refs].filter((ref) => !resolve(ref));
    expect(dangling).toEqual([]);
  });

  it('protects authenticated endpoint groups with the bearer scheme', () => {
    expect(spec.components?.schemas).toBeDefined();

    const protectedPaths = ['/v1/webhooks', '/v1/fleets', '/v1/disputes', '/v1/notifications'];
    for (const pathKey of protectedPaths) {
      const getOperation = { ...spec.paths[pathKey] } as Record<string, { security?: unknown }>;
      expect(getOperation.get?.security).toBeDefined();
    }
  });
});
