import type { Env } from "../env";

/**
 * Minimal OpenAI-compatible client (BYOK).
 * Works with official APIs and OpenAI-compatible gateways alike:
 * the user brings their own key and endpoint (LLM_BASE_URL).
 */

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function post<T>(env: Env, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.LLM_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Chat completion that must return a JSON object. Throws if it does not parse. */
export async function chatJSON<T>(
  env: Env,
  messages: ChatMessage[],
): Promise<T> {
  const data = await post<{ choices: { message: { content: string } }[] }>(
    env,
    "/chat/completions",
    {
      model: env.LLM_MODEL,
      messages,
      response_format: { type: "json_object" },
    },
  );
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("LLM returned an empty response");
  return JSON.parse(content) as T;
}

/** Embed texts with the configured embedding model. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const data = await post<{ data: { embedding: number[] }[] }>(
    env,
    "/embeddings",
    { model: env.EMBEDDING_MODEL, input: texts },
  );
  return data.data.map((d) => d.embedding);
}
