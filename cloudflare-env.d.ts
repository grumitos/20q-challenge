interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
  };
}

/**
 * Cloudflare's own cache, which the standard `CacheStorage` type has no name
 * for. Declared here because this project carries hand-rolled runtime shims
 * rather than `@cloudflare/workers-types`.
 */
interface CacheStorage {
  readonly default: Cache;
}
