import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "closedbook",
		compatibilityDate: "2025-01-01",
		entrypoint: "src/index.ts",
		env: {
			LLM_BASE_URL: bindings.text("https://api.ai.sakura.ad.jp/v1"),
			LLM_MODEL: bindings.text("preview/DeepSeek-V4.1-Flash-1017"),
			EMBEDDING_MODEL: bindings.text("multilingual-e5-large"),
			LLM_API_KEY: bindings.secret(),
			DB: bindings.d1({
				name: "closedbook",
				id: "4f346e54-4641-4a9f-9aa1-9829fc1527eb",
			}),
			BUCKET: bindings.r2({
				name: "closedbook-sources",
			}),
			VECTORIZE: bindings.vectorize({
				name: "closedbook-chunks",
			}),
		},
	},
});
