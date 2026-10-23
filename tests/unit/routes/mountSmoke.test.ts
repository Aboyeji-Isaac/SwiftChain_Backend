import fs from 'fs';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import ts from 'typescript';
import routes from '../../../src/routes';
import errorHandler from '../../../src/middleware/errorHandler';

jest.mock('../../../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../../src/config/redis', () => ({
  __esModule: true,
  default: {},
  redisClient: {},
}));

const ROUTES_DIR = path.resolve(__dirname, '../../../src/routes');
const README_PATH = path.resolve(__dirname, '../../../README.md');
const ROUTE_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// ─── Router stack discovery ────────────────────────────────────────────────────

interface MountedRoute {
  method: string;
  path: string;
}

/** Convert a mounted sub-router's regexp back into its literal path prefix. */
const prefixFromRegexp = (regexp: RegExp & { fast_slash?: boolean }): string => {
  if (regexp.fast_slash) return '';
  return regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
};

interface StackLayer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
  regexp?: RegExp & { fast_slash?: boolean };
}

const collectMountedRoutes = (stack: StackLayer[], prefix = ''): MountedRoute[] => {
  const found: MountedRoute[] = [];

  for (const layer of stack) {
    if (layer.route && typeof layer.route.path === 'string') {
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) {
          found.push({ method, path: `${prefix}${layer.route.path}` });
        }
      }
    } else if (layer.handle?.stack && layer.regexp) {
      found.push(
        ...collectMountedRoutes(layer.handle.stack, `${prefix}${prefixFromRegexp(layer.regexp)}`),
      );
    }
  }

  return found;
};

/** Replace express path params (`:id`) with a concrete, well-formed value. */
const concretise = (routePath: string): string =>
  routePath.replace(/:([A-Za-z_]\w*)/g, 'smoke-param').replace(/\/+/g, '/');

// ─── Static analysis helpers ───────────────────────────────────────────────────

const readRouteSource = (fileName: string): ts.SourceFile => {
  const text = fs.readFileSync(path.join(ROUTES_DIR, fileName), 'utf8');
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
};

const routeFileNames = (): string[] =>
  fs
    .readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .sort();

/** Names bound at module top level: imports, variables, and functions. */
const topLevelBindings = (sf: ts.SourceFile): Set<string> => {
  const bound = new Set<string>();

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const { name, namedBindings } = statement.importClause;
      if (name) bound.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bound.add(namedBindings.name.text);
      }
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        namedBindings.elements.forEach((element) => bound.add(element.name.text));
      }
    } else if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) => {
        if (ts.isIdentifier(declaration.name)) bound.add(declaration.name.text);
      });
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      bound.add(statement.name.text);
    }
  }

  return bound;
};

/**
 * Identifiers passed directly as handlers to `router.<verb>(...)` / `router.use(...)`
 * (e.g. `dlqController.retryDlqEntry`, `authenticate`). Inline arrow functions are
 * skipped because their parameters are not module-level references.
 */
const referencedHandlerRoots = (sf: ts.SourceFile): string[] => {
  const roots: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ROUTE_VERBS.includes(node.expression.name.text)
    ) {
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) {
          roots.push(argument.text);
        } else if (ts.isPropertyAccessExpression(argument)) {
          let root: ts.Expression = argument;
          while (ts.isPropertyAccessExpression(root)) root = root.expression;
          if (ts.isIdentifier(root)) roots.push(root.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return roots;
};

/** Route modules that `routes/index.ts` imports, by module basename. */
const importedByIndex = (): Set<string> => {
  const sf = readRouteSource('index.ts');
  const modules = new Set<string>();

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      if (spec.startsWith('./')) modules.add(spec.slice(2));
    }
  }

  return modules;
};

// ─── App under test ────────────────────────────────────────────────────────────

const buildApp = (): express.Express => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use((req, res) => {
    res.status(404).json({ success: false, data: null, error: 'not found', message: req.path });
  });
  app.use(errorHandler);
  return app;
};

beforeAll(() => {
  // Queries fail fast instead of buffering for ten seconds when no DB is connected.
  mongoose.set('bufferCommands', false);
});

afterAll(() => {
  mongoose.set('bufferCommands', true);
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('route mount smoke test', () => {
  const app = buildApp();
  const mounted = collectMountedRoutes(
    (routes as unknown as { stack: StackLayer[] }).stack,
    '/api',
  );

  it('discovers the mounted routes from the router stack', () => {
    expect(mounted.length).toBeGreaterThan(50);
    expect(mounted.some((route) => route.path === '/api/v1/admin/dlq')).toBe(true);
    expect(mounted.some((route) => route.path === '/api/v1/admin/dlq/:id/retry')).toBe(true);
  });

  it('every mounted route answers with a structured JSON envelope and never crashes', async () => {
    const failures: string[] = [];

    for (const route of mounted) {
      const method = route.method as (typeof HTTP_METHODS)[number];
      if (!HTTP_METHODS.includes(method)) continue;

      const url = concretise(route.path);
      const agent = request(app)[method](url);
      const response =
        method === 'get' || method === 'delete'
          ? await agent
          : await agent.set('Content-Type', 'application/json').send({});

      const label = `${method.toUpperCase()} ${route.path}`;
      const isJson = /application\/json/.test(response.headers['content-type'] ?? '');
      const hasEnvelope = typeof response.body?.success === 'boolean';
      const leaksHandlerError = /is not defined|is not a function|Cannot read prop/.test(
        JSON.stringify(response.body ?? {}),
      );

      if (!isJson || !hasEnvelope || leaksHandlerError) {
        failures.push(`${label} -> ${response.status} ${JSON.stringify(response.body)}`);
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);

  it('every controller or middleware passed to a router is imported in its route file', () => {
    const unresolved: string[] = [];

    for (const file of routeFileNames()) {
      const sf = readRouteSource(file);
      const bound = topLevelBindings(sf);

      for (const root of referencedHandlerRoots(sf)) {
        if (!bound.has(root)) unresolved.push(`${file} references "${root}" without importing it`);
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('every route file is either mounted from routes/index.ts or not documented in the README', () => {
    const imported = importedByIndex();
    const readme = fs.readFileSync(README_PATH, 'utf8');

    const orphaned = routeFileNames()
      .map((file) => file.replace(/\.ts$/, ''))
      .filter((moduleName) => !imported.has(moduleName))
      .filter((moduleName) => readme.includes(moduleName));

    expect(orphaned).toEqual([]);
  });
});
