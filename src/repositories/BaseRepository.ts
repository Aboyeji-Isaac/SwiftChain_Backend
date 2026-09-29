import { Document, FilterQuery, Model, Query, QueryOptions, Types, UpdateQuery } from 'mongoose';
import { IRepository, Page, ReadOptions, WriteOptions } from './types';

/**
 * Generic Mongoose-backed implementation of {@link IRepository}.
 *
 * This is the only layer in the application allowed to touch a Mongoose model
 * directly. Concrete repositories extend it to add domain-specific queries;
 * services consume those repositories and never import a model themselves.
 *
 * Invalid ObjectId strings resolve to `null`/`false` rather than throwing, so
 * a malformed path parameter surfaces as a clean 404 in the service layer
 * instead of a Mongoose CastError leaking out as a 500.
 *
 * @typeParam T - The hydrated document type (must extend Mongoose `Document`).
 */
export abstract class BaseRepository<T extends Document> implements IRepository<T> {
  protected constructor(protected readonly model: Model<T>) {}

  /** The registered Mongoose model name, useful for logs and error messages. */
  public get modelName(): string {
    return this.model.modelName;
  }

  /**
   * Apply the shared read options to a query.
   *
   * Kept in one place so every read path treats projection, sorting,
   * pagination and session handling identically.
   */
  protected applyReadOptions<R>(query: Query<R, T>, options?: ReadOptions<T>): Query<R, T> {
    if (!options) return query;

    if (options.queryOptions) query.setOptions(options.queryOptions as QueryOptions<T>);
    // `select` rather than `projection`: it accepts the full ProjectionType
    // union (string shorthand such as '+password' included), which the
    // narrower `projection` overloads reject.
    if (options.projection !== undefined) {
      query.select(
        options.projection as string | string[] | Record<string, number | boolean | object>,
      );
    }
    if (options.sort) query.sort(options.sort);
    if (typeof options.skip === 'number') query.skip(options.skip);
    if (typeof options.limit === 'number') query.limit(options.limit);
    if (options.populate) query.populate(options.populate as string | string[]);
    if (options.session) query.session(options.session);
    if (options.lean) query.lean();

    return query;
  }

  /**
   * Guard against Mongoose CastErrors on user-supplied identifiers.
   *
   * @returns `true` when `id` is a well-formed ObjectId.
   */
  protected isValidId(id: string): boolean {
    return Types.ObjectId.isValid(id);
  }

  async create(data: Partial<T>, options?: WriteOptions): Promise<T> {
    const [created] = await this.model.create([data], {
      session: options?.session,
    });
    return created;
  }

  /**
   * Insert many documents in a single round trip.
   *
   * Pass `ordered: false` to let the driver continue past individual failures
   * — required by bulk imports that must report partial success.
   */
  async createMany(data: Partial<T>[], options?: WriteOptions): Promise<T[]> {
    if (data.length === 0) return [];

    const inserted = await this.model.insertMany(data, {
      session: options?.session,
      ordered: options?.ordered ?? true,
      rawResult: false,
    });

    return inserted as unknown as T[];
  }

  async findById(id: string, options?: ReadOptions<T>): Promise<T | null> {
    if (!this.isValidId(id)) return null;
    return this.applyReadOptions(this.model.findById(id), options).exec() as Promise<T | null>;
  }

  async findOne(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<T | null> {
    return this.applyReadOptions(this.model.findOne(filter), options).exec() as Promise<T | null>;
  }

  async find(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<T[]> {
    return this.applyReadOptions(this.model.find(filter), options).exec() as Promise<T[]>;
  }

  /**
   * Run a filtered query and its matching count concurrently.
   *
   * `page` and `limit` are clamped so a hostile or buggy caller cannot request
   * a negative skip or an unbounded result set.
   */
  async paginate(
    filter: FilterQuery<T>,
    page: number,
    limit: number,
    options?: ReadOptions<T>,
  ): Promise<Page<T>> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 10), 100);
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.find(filter, { ...options, skip, limit: safeLimit }),
      this.count(filter, options),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async count(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<number> {
    const query = this.model.countDocuments(filter);
    if (options?.queryOptions) query.setOptions(options.queryOptions as QueryOptions<T>);
    if (options?.session) query.session(options.session);
    return query.exec();
  }

  async exists(filter: FilterQuery<T>, options?: ReadOptions<T>): Promise<boolean> {
    const query = this.model.exists(filter);
    if (options?.queryOptions) query.setOptions(options.queryOptions as QueryOptions<T>);
    if (options?.session) query.session(options.session);
    return (await query.exec()) !== null;
  }

  async updateById(id: string, update: UpdateQuery<T>, options?: WriteOptions): Promise<T | null> {
    if (!this.isValidId(id)) return null;
    return this.model
      .findByIdAndUpdate(id, update, {
        new: true,
        runValidators: options?.runValidators ?? true,
        session: options?.session,
      })
      .exec() as Promise<T | null>;
  }

  async updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options?: WriteOptions,
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate(filter, update, {
        new: true,
        runValidators: options?.runValidators ?? true,
        session: options?.session,
      })
      .exec() as Promise<T | null>;
  }

  async deleteById(id: string, options?: WriteOptions): Promise<boolean> {
    if (!this.isValidId(id)) return false;
    const result = await this.model.findByIdAndDelete(id, { session: options?.session }).exec();
    return result !== null;
  }
}
