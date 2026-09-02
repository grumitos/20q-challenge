declare module "bun:sqlite" {
  type SQLiteValue = string | number | bigint | Uint8Array | null;

  export interface Statement {
    get<T = unknown>(...values: SQLiteValue[]): T | null;
    all<T = unknown>(...values: SQLiteValue[]): T[];
    run(...values: SQLiteValue[]): unknown;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    strict?: boolean;
    safeIntegers?: boolean;
  }

  export class Database {
    constructor(filename: string, options?: DatabaseOptions);
    query(sql: string): Statement;
    exec(sql: string): void;
    transaction<T>(callback: () => T): () => T;
    close(force?: boolean): void;
  }
}

declare const Bun: {
  serve(options: {
    hostname?: string;
    port?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { stop(): Promise<void> };
};
