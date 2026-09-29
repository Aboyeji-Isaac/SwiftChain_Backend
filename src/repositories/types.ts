import { ClientSession, FilterQuery, ProjectionType, QueryOptions, UpdateQuery } from 'mongoose';

/**
 * Options accepted by every read operation on a repository.
 *
 * These intentionally mirror the subset of Mongoose's `QueryOptions` that the
 * service layer legitimately needs, so callers never have to import Mongoose
 * types to talk to a repository.
 */
export interface ReadOptions<T> {
  /** Field selection, e.g. `'+password'` or `{ password: 1 }`. */
  projection?: ProjectionType<T>;
  /** Sort specification, e.g. `{ createdAt: -1 }`. */
  sort?: Record<string, 1 | -1>;
  /** Number of documents to skip (pagination offset). */
  skip?: number;
  /** Maximum number of documents to return. */
  limit?: number;
  /** Paths to populate. */
  populate?: string | string[];
  /**
   * Return plain JavaScript objects instead of hydrated Mongoose documents.
   * Faster, but the result has no instance methods (e.g. `softDelete`).
   */
  lean?: boolean;
  /** Transaction session to run the query in. */
  session?: ClientSession;
  /**
   * Extra driver-level options passed through to `Query.setOptions`.
   *
   * Needed for schema plugins that read custom options — the soft-delete
   * plugin on `Delivery`, for instance, honours `includeDeleted`.
   */
  queryOptions?: QueryOptions<T>;
}

/** Options accepted by every write operation on a repository. */
export interface WriteOptions {
  /** Transaction session to run the write in. */
  session?: ClientSession;
  /** Run schema validators on update operations. Defaults to `true`. */
  runValidators?: boolean;
  /**
   * Continue past individual failures during `insertMany` instead of aborting
   * on the first error. Required for partial-success bulk imports.
   */
  ordered?: boolean;
}

/** A single page of results plus the metadata needed to render pagination. */
export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * The persistence contract every repository satisfies.
 *
 * Services depend on this interface rather than on Mongoose models, which is
 * what makes the business logic testable against a fake and swappable if the
 * storage engine ever changes.
 *
 * @typeParam T - The document shape managed by the repository.
 */
export interface IRepository<T> {
  create(data: Partial<T>, options?: WriteOptions): Promise<T>;
  createMany(data: Partial<T>[], options?: WriteOptions): Promise<T[]>;
  findById(id: string, options?: ReadOptions<T>): Promise<T | null>;
  findOne(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<T | null>;
  find(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<T[]>;
  paginate(
    filter: FilterQuery<T>,
    page: number,
    limit: number,
    options?: ReadOptions<T>,
  ): Promise<Page<T>>;
  count(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<number>;
  exists(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<boolean>;
  updateById(id: string, update: UpdateQuery<T>, options?: WriteOptions): Promise<T | null>;
  updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options?: WriteOptions,
  ): Promise<T | null>;
  deleteById(id: string, options?: WriteOptions): Promise<boolean>;
}
