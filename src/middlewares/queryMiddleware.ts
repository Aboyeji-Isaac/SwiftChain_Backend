import { NextFunction, Request, RequestHandler, Response } from 'express';
import { FilterQuery, SortOrder, Types } from 'mongoose';
import ApiError from '../utils/ApiError';
import {
  FilterableFieldType,
  PaginatedResult,
  PaginationMeta,
  QueryFeatureConfig,
  QueryOptions,
} from '../types/query';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 100;

/**
 * Mongo comparison operators a client may append to a filter field, e.g.
 * `?amount[gte]=100`. Restricting the set keeps `$where`-style injection and
 * expensive operators out of generated queries.
 */
const ALLOWED_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'] as const;
type FilterOperator = (typeof ALLOWED_OPERATORS)[number];

const isFilterOperator = (value: string): value is FilterOperator =>
  (ALLOWED_OPERATORS as readonly string[]).includes(value);

/** Parses a positive integer query parameter, rejecting malformed input. */
const parsePositiveInt = (raw: unknown, field: string, fallback: number): number => {
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (typeof raw !== 'string') {
    throw ApiError.badRequest(`\`${field}\` must be a single numeric value`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw ApiError.badRequest(`\`${field}\` must be a positive integer`);
  }

  return parsed;
};

/** Coerces a raw query-string value to the type declared for its field. */
const coerceValue = (raw: string, type: FilterableFieldType, field: string): unknown => {
  switch (type) {
    case 'number': {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw ApiError.badRequest(`\`${field}\` must be a valid number`);
      }
      return parsed;
    }
    case 'boolean': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw ApiError.badRequest(`\`${field}\` must be either "true" or "false"`);
    }
    case 'date': {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw ApiError.badRequest(`\`${field}\` must be a valid ISO 8601 date`);
      }
      return parsed;
    }
    case 'objectId': {
      if (!Types.ObjectId.isValid(raw)) {
        throw ApiError.badRequest(`\`${field}\` must be a valid identifier`);
      }
      return new Types.ObjectId(raw);
    }
    case 'string':
    default:
      return raw;
  }
};

/**
 * Escapes regular-expression metacharacters so that a user-supplied search
 * term is matched literally and cannot trigger catastrophic backtracking.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses the `sort` parameter, e.g. `?sort=-createdAt,name`.
 *
 * A leading `-` denotes descending order. Fields outside `sortableFields`
 * are rejected rather than ignored, so a client typo surfaces immediately
 * instead of silently returning arbitrarily ordered pages.
 */
const parseSort = (raw: unknown, config: QueryFeatureConfig): Record<string, SortOrder> => {
  const fallback = config.defaultSort ?? { createdAt: -1 };

  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (typeof raw !== 'string') {
    throw ApiError.badRequest('`sort` must be a single comma-separated string');
  }

  const sort: Record<string, SortOrder> = {};

  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') {
      continue;
    }

    const descending = trimmed.startsWith('-');
    const field = descending ? trimmed.slice(1) : trimmed;

    if (!config.sortableFields.includes(field)) {
      throw ApiError.badRequest(
        `Cannot sort by \`${field}\`. Sortable fields: ${config.sortableFields.join(', ')}`,
      );
    }

    sort[field] = descending ? -1 : 1;
  }

  return Object.keys(sort).length > 0 ? sort : fallback;
};

/** Builds the `$or` clause backing the free-text `search` parameter. */
const buildSearchClause = (
  raw: unknown,
  config: QueryFeatureConfig,
): FilterQuery<unknown> | null => {
  if (raw === undefined || raw === '' || !config.searchableFields?.length) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw ApiError.badRequest('`search` must be a single string value');
  }

  const term = raw.trim();
  if (term === '') {
    return null;
  }

  const pattern = new RegExp(escapeRegExp(term), 'i');
  return {
    $or: config.searchableFields.map((field) => ({ [field]: pattern })),
  };
};

/**
 * Builds a Mongoose filter from the whitelisted query-string fields.
 *
 * Supports both direct equality (`?status=pending`) and bracketed operators
 * (`?amount[gte]=100`, `?status[in]=pending,accepted`).
 */
const buildFilter = (query: Request['query'], config: QueryFeatureConfig): FilterQuery<unknown> => {
  const filter: Record<string, unknown> = {};

  for (const [field, type] of Object.entries(config.filterableFields)) {
    const raw = query[field];

    if (raw === undefined || raw === '') {
      continue;
    }

    // Direct equality: ?status=pending
    if (typeof raw === 'string') {
      filter[field] = coerceValue(raw, type, field);
      continue;
    }

    // Operator form: ?amount[gte]=100
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const conditions: Record<string, unknown> = {};

      for (const [operator, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isFilterOperator(operator)) {
          throw ApiError.badRequest(
            `Unsupported operator \`${operator}\` on \`${field}\`. ` +
              `Supported operators: ${ALLOWED_OPERATORS.join(', ')}`,
          );
        }

        if (typeof value !== 'string') {
          throw ApiError.badRequest(`\`${field}[${operator}]\` must be a single value`);
        }

        if (operator === 'in' || operator === 'nin') {
          conditions[`$${operator}`] = value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '')
            .map((entry) => coerceValue(entry, type, field));
          continue;
        }

        conditions[`$${operator}`] = coerceValue(value, type, field);
      }

      if (Object.keys(conditions).length > 0) {
        filter[field] = conditions;
      }
      continue;
    }

    throw ApiError.badRequest(`\`${field}\` was supplied in an unsupported format`);
  }

  return filter as FilterQuery<unknown>;
};

/**
 * Express middleware factory producing normalized, validated query options.
 *
 * Each route declares which fields it exposes; anything else in the query
 * string is ignored. The parsed result is attached to `req.queryOptions` for
 * the controller and service layers to consume, so no route has to reimplement
 * pagination, sorting or filtering logic.
 */
export const buildQueryOptions =
  (config: QueryFeatureConfig): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const maxLimit = config.maxLimit ?? DEFAULT_MAX_LIMIT;
      const page = parsePositiveInt(req.query.page, 'page', DEFAULT_PAGE);
      const requestedLimit = parsePositiveInt(
        req.query.limit,
        'limit',
        config.defaultLimit ?? DEFAULT_LIMIT,
      );

      // Clamp rather than reject so a client asking for a large page still
      // gets a response, just a bounded one.
      const limit = Math.min(requestedLimit, maxLimit);

      const filter = buildFilter(req.query, config);
      const searchClause = buildSearchClause(req.query.search, config);

      const combinedFilter = searchClause
        ? ({ $and: [filter, searchClause] } as FilterQuery<unknown>)
        : filter;

      const options: QueryOptions = {
        page,
        limit,
        skip: (page - 1) * limit,
        sort: parseSort(req.query.sort, config),
        filter: combinedFilter,
      };

      req.queryOptions = options;
      next();
    } catch (error) {
      next(error);
    }
  };

/**
 * Falls back to safe defaults when a handler runs without the middleware,
 * keeping the service layer free of null checks.
 */
export const resolveQueryOptions = (req: Request): QueryOptions =>
  req.queryOptions ?? {
    page: DEFAULT_PAGE,
    limit: DEFAULT_LIMIT,
    skip: 0,
    sort: { createdAt: -1 },
    filter: {},
  };

/** Derives the pagination metadata returned with every paginated response. */
export const buildPaginationMeta = (
  totalItems: number,
  page: number,
  limit: number,
): PaginationMeta => {
  const totalPages = limit > 0 ? Math.ceil(totalItems / limit) : 0;
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1 && totalItems > 0;

  return {
    totalItems,
    totalPages,
    currentPage: page,
    limit,
    hasNextPage,
    hasPreviousPage,
    nextPage: hasNextPage ? page + 1 : null,
    previousPage: hasPreviousPage ? page - 1 : null,
  };
};

export type { PaginatedResult, PaginationMeta, QueryFeatureConfig, QueryOptions };

export default { buildQueryOptions, resolveQueryOptions, buildPaginationMeta };
