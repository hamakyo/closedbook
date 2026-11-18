export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  EMBEDDING_MODEL: string;
  LLM_API_KEY: string;
  /**
   * Optional secret. When set, the whole app (UI and API) requires HTTP
   * Basic authentication with this password (any username). When unset,
   * the app refuses all requests: the stored content is derived from the
   * user's own study materials and must never be world-readable by
   * accident. Set with: wrangler secret put UI_PASSWORD
   */
  UI_PASSWORD?: string;
}
