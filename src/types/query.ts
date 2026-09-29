import { FilterQuery, SortOrder } from 'mongoose';

/**
 * Normalized, validated query options produced by the query middleware and
 * consumed by the service layer to build Mongoose queries.
 */
export interface QueryOptions<T = unknown> {
  /** 1-based page number. */
  page: number;
  /** Number of documents per page. */
  limit: number;
  /** Number of documents to skip, derived from `page` and `limit`. */
  skip: number;
  /** Mongoose sort specification, e.g. `{ createdAt: -1 }`. */
  sort: Record<string, SortOrder>;
  /** Whitelisted Mongoose filter built from the request query string. */
  filter: FilterQuery<T>;
  /** Projection limiting the returned fields, or `undefined` for all fields. */
  projection?: string;
}

/** Pagination metadata returned alongside every paginated collection. */
export interface PaginationMeta {
  totalItems: number;
  totalPages: number;
  currentPage: number;
  limit: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPage: number | null;
  previousPage: number | null;
}

/** A page of results together with its pagination metadata. */
export interface PaginatedResult<T> {
  items: T[];
  meta: PaginationMeta;
}

/**
 * Declares which query-string fields a route allows clients to filter and
 * sort by. Anything not listed here is ignored, which prevents clients from
 * querying sensitive or unindexed fields.
 */
export interface QueryFeatureConfig {
  /** Fields that may be used in `sort`. */
  sortableFields: readonly string[];
  /** Fields that may be used as filters, mapped to their coercion type. */
  filterableFields: Readonly<Record<string, FilterableFieldType>>;
  /** Fields matched by the free-text `search` parameter. */
  searchableFields?: readonly string[];
  /** Sort applied when the client does not supply one. */
  defaultSort?: Record<string, SortOrder>;
  /** Page size used when the client does not supply one. */
  defaultLimit?: number;
  /** Upper bound on the page size a client may request. */
  maxLimit?: number;
}

/** Supported coercion types for filterable query-string fields. */
export type FilterableFieldType = 'string' | 'number' | 'boolean' | 'date' | 'objectId';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `buildQueryOptions` middleware. */
      queryOptions?: QueryOptions;
    }
  }
}
