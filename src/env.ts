export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  EMBEDDING_MODEL: string;
  LLM_API_KEY: string;
}
