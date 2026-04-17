import { createRequire } from "module";
import type BetterSqlite3Module from "better-sqlite3";

type DatabaseOptions = {
  create?: boolean;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
  nativeBinding?: string | undefined;
};

export type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export interface Statement<BindParameters extends unknown[] | {} = unknown[], Result = unknown> {
  run(...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]): RunResult;
  get(...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]): Result;
  all(...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]): Result[];
  iterate(
    ...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]
  ): IterableIterator<Result>;
}

export interface Database {
  run(sql: string, ...params: unknown[]): RunResult;
  prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
    source: string,
  ): Statement<BindParameters, Result>;
  close(): void;
  transaction<T extends (...args: unknown[]) => void>(fn: T): T;
}

export interface DatabaseConstructor {
  new (filename?: string | Buffer, options?: DatabaseOptions): Database;
  prototype: Database;
}

class BetterSqlite3Database implements Database {
  private readonly db: BetterSqlite3Module.Database;

  constructor(filename?: string | Buffer, options?: DatabaseOptions) {
    const dbOptions: BetterSqlite3Module.Options = {};
    if (typeof options?.readonly === "boolean") dbOptions.readonly = options.readonly;
    if (typeof options?.fileMustExist === "boolean") {
      dbOptions.fileMustExist = options.fileMustExist;
    } else if (options?.readonly === true || options?.create === false) {
      dbOptions.fileMustExist = true;
    }
    if (typeof options?.timeout === "number") dbOptions.timeout = options.timeout;
    if (options?.verbose) dbOptions.verbose = options.verbose;
    if (options?.nativeBinding) dbOptions.nativeBinding = options.nativeBinding;

    const BetterSqlite3 = loadBetterSqlite3();
    this.db = new BetterSqlite3(filename, dbOptions);
  }

  run(sql: string, ...params: unknown[]): RunResult {
    if (params.length === 0) {
      this.db.exec(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }

    const boundParams = params.length === 1 ? params[0] : params;
    return this.db.prepare(sql).run(boundParams as never) as RunResult;
  }

  prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
    source: string,
  ): Statement<BindParameters, Result> {
    return this.db.prepare(source) as unknown as Statement<BindParameters, Result>;
  }

  close(): void {
    this.db.close();
  }

  transaction<T extends (...args: unknown[]) => void>(fn: T): T {
    return this.db.transaction(fn) as unknown as T;
  }
}

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

function loadBetterSqlite3(): typeof BetterSqlite3Module {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof BetterSqlite3Module;
}

const sqliteModule = isBunRuntime()
  ? ((await import("bun:sqlite")) as { Database: DatabaseConstructor })
  : { Database: BetterSqlite3Database as unknown as DatabaseConstructor };

export const Database = sqliteModule.Database;
