import { Hono } from "hono";
import type { Env } from "../env";
import { chunkMarkdown } from "../lib/chunk";
import { chatJSON, embed } from "../lib/llm";

/**
 * The learning protocol. Each phase is a fixed step, in order:
 *   Phase 1  skeleton      -> knowledge map from the sources (grounded, cited)
 *   Phase 2  controversies -> real disagreements in the sources, never invented
 *   Phase 3  test          -> generate questions (answers kept server-side),
 *                             answer with sources locked, then grade for
 *                             what is missing and what is shallow
 *   Phase 4  gaps          -> tracked understanding gaps + retests
 *
 * Phase 0 and Phase 1 are implemented; the rest remain stubs (501).
 * See docs/design-memo.md for the spec.
 */
export const phases = new Hono<{ Bindings: Env }>();

const notImplemented = (todo: string) => ({ error: "not_implemented", todo });

const EMBED_BATCH_SIZE = 16;
const VECTOR_UPSERT_BATCH_SIZE = 100;

interface ChunkRow {
  id: string;
  idx: number;
  text: string;
  chapter: string | null;
}

interface SourceRow {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  r2_key: string | null;
  page_count: number | null;
  created_at: string;
}

interface SourceWithCount extends SourceRow {
  chunk_count: number;
}

function isFile(value: File | string | null): value is File {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as File).arrayBuffer === "function"
  );
}

/** Keep the R2 key safe and flat; the project/source ids provide uniqueness. */
function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "source.txt";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "_");
  return cleaned.slice(0, 200) || "source.txt";
}

function contentTypeFor(fileName: string, declared: string): string {
  if (declared) return declared;
  return /\.(md|markdown)$/i.test(fileName)
    ? "text/markdown; charset=utf-8"
    : "text/plain; charset=utf-8";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort rollback. D1 writes happen in one atomic batch, but if the batch
 * result is ambiguous (or a later read fails) deleting the freshly generated
 * source id makes sure no source row can point at missing chunks.
 */
async function cleanupFailedIngestion(
  env: Env,
  sourceId: string,
  r2Key: string,
  r2Stored: boolean,
  chunkIds: string[],
): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE source_id = ?").bind(sourceId),
      env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId),
    ]);
  } catch (error) {
    console.error("failed to roll back source rows", error);
  }

  try {
    for (let i = 0; i < chunkIds.length; i += VECTOR_UPSERT_BATCH_SIZE) {
      await env.VECTORIZE.deleteByIds(
        chunkIds.slice(i, i + VECTOR_UPSERT_BATCH_SIZE),
      );
    }
  } catch (error) {
    console.error("failed to roll back vectors", error);
  }

  if (r2Stored) {
    try {
      await env.BUCKET.delete(r2Key);
    } catch (error) {
      console.error("failed to roll back R2 object", error);
    }
  }
}

// Phase 0: register a source file. The original goes to R2, the Markdown/text
// is chunked, the chunks are embedded into Vectorize, and source + chunks are
// written to D1 atomically. PDFs are converted to Markdown before upload.
phases.post("/:id/sources", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "invalid_form_data", message: "Expected multipart/form-data" },
      400,
    );
  }

  const uploaded = form.get("file");
  if (!isFile(uploaded)) {
    return c.json(
      { error: "file is required", message: "Attach a Markdown or text file as 'file'" },
      400,
    );
  }

  const fileName = uploaded.name.trim() || "source.txt";
  const baseName = fileName.split(/[/\\]/).pop()?.trim() || "source.txt";
  if (/\.pdf$/i.test(baseName)) {
    return c.json(
      {
        error: "unsupported_file_type",
        message:
          "PDF uploads are not supported. Convert the PDF to Markdown first (for example with Microsoft MarkItDown).",
      },
      400,
    );
  }

  const titleField = form.get("title");
  const title =
    typeof titleField === "string" && titleField.trim()
      ? titleField.trim()
      : baseName;
  const kindField = form.get("kind");
  const kind =
    typeof kindField === "string" && kindField.trim()
      ? kindField.trim()
      : "other";

  let bytes: ArrayBuffer;
  try {
    bytes = await uploaded.arrayBuffer();
  } catch (error) {
    return c.json(
      {
        error: "file_read_failed",
        message: `Could not read the uploaded file: ${errorMessage(error)}`,
      },
      400,
    );
  }
  if (bytes.byteLength === 0) {
    return c.json({ error: "empty_file", message: "The uploaded file is empty" }, 400);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch (error) {
    return c.json(
      {
        error: "invalid_utf8",
        message: `Could not decode the uploaded file as UTF-8: ${errorMessage(error)}`,
      },
      400,
    );
  }
  if (!text.trim()) {
    return c.json(
      { error: "empty_document", message: "The uploaded document contains no text" },
      400,
    );
  }

  const chunks = chunkMarkdown(text);
  if (chunks.length === 0) {
    return c.json(
      { error: "empty_document", message: "The uploaded document produced no chunks" },
      400,
    );
  }

  const sourceId = crypto.randomUUID();
  const r2Key = `projects/${projectId}/sources/${sourceId}/${safeFileName(baseName)}`;
  const chunkRows: ChunkRow[] = chunks.map((chunk, idx) => ({
    id: crypto.randomUUID(),
    idx,
    text: chunk.text,
    chapter: chunk.chapter,
  }));

  let r2Stored = false;
  try {
    await c.env.BUCKET.put(r2Key, bytes, {
      httpMetadata: {
        contentType: contentTypeFor(baseName, uploaded.type),
      },
    });
    r2Stored = true;

    const vectors: VectorizeVector[] = [];
    let dimensions: number | null = null;

    for (let i = 0; i < chunkRows.length; i += EMBED_BATCH_SIZE) {
      const batch = chunkRows.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await embed(
        c.env,
        batch.map((row) => row.text),
      );
      if (embeddings.length !== batch.length) {
        throw new Error(
          `Embedding API returned ${embeddings.length} vectors for ${batch.length} chunks`,
        );
      }

      for (let j = 0; j < batch.length; j += 1) {
        const values = embeddings[j];
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`Embedding API returned an empty vector for chunk ${batch[j].idx}`);
        }
        if (dimensions === null) dimensions = values.length;
        if (values.length !== dimensions) {
          throw new Error(
            `Embedding dimensions changed within the document (${dimensions} vs ${values.length})`,
          );
        }
        vectors.push({
          id: batch[j].id,
          values,
          metadata: {
            project_id: projectId,
            source_id: sourceId,
          },
        });
      }
    }

    for (let i = 0; i < vectors.length; i += VECTOR_UPSERT_BATCH_SIZE) {
      await c.env.VECTORIZE.upsert(
        vectors.slice(i, i + VECTOR_UPSERT_BATCH_SIZE),
      );
    }

    // D1 batch is a transaction: either the source and every chunk land, or
    // none of them do.
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO sources (id, project_id, title, kind, r2_key, page_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(sourceId, projectId, title, kind, r2Key, null),
      ...chunkRows.map((row) =>
        c.env.DB
          .prepare(
            `INSERT INTO chunks (id, source_id, project_id, idx, text, page, chapter)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            sourceId,
            projectId,
            row.idx,
            row.text,
            null,
            row.chapter,
          ),
      ),
    ]);

    const source = await c.env.DB.prepare(
      "SELECT * FROM sources WHERE id = ?",
    )
      .bind(sourceId)
      .first<SourceRow>();
    if (!source) throw new Error("Source row was not found after insertion");

    return c.json(
      {
        source: { ...source, chunk_count: chunkRows.length },
        chunk_count: chunkRows.length,
      },
      201,
    );
  } catch (error) {
    console.error("source ingestion failed", error);
    await cleanupFailedIngestion(
      c.env,
      sourceId,
      r2Key,
      r2Stored,
      chunkRows.map((row) => row.id),
    );
    return c.json(
      {
        error: "source_ingestion_failed",
        message: errorMessage(error),
      },
      500,
    );
  }
});

phases.get("/:id/sources", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.project_id, s.title, s.kind, s.r2_key, s.page_count,
            s.created_at, COUNT(c.id) AS chunk_count
       FROM sources s
       LEFT JOIN chunks c ON c.source_id = s.id
      WHERE s.project_id = ?
      GROUP BY s.id
      ORDER BY s.created_at ASC, s.id ASC`,
  )
    .bind(projectId)
    .all<SourceWithCount>();

  const sources = results.map((source) => ({
    ...source,
    chunk_count: Number(source.chunk_count) || 0,
  }));
  const totalChunks = sources.reduce(
    (sum, source) => sum + source.chunk_count,
    0,
  );

  return c.json({
    sources,
    coverage: {
      source_count: sources.length,
      chunk_count: totalChunks,
    },
  });
});

// ---------------------------------------------------------------------------
// Phase 1: the knowledge skeleton. Ask the fixed core-consensus question
// against the project's chunks and store a structured map: concept nodes in
// three layers (foundation / core / branch) plus typed relation edges.
// Grounding rule (design memo §2/§5): every node and edge must cite chunks
// from the provided set. Anything the model cannot cite is dropped, never
// stored, and the drop counts are reported back.
// ---------------------------------------------------------------------------

const PHASE1_QUESTION =
  "この分野で広く受け入れられている中核的な共通認識には、どんなものがある？ その基礎となる概念、重要な原則、全体の枠組みを整理し、これらの知識の関係を説明して";

/** At or below this many chunks the whole corpus goes into the prompt. */
const ALL_CHUNKS_LIMIT = 60;
/** Above the limit, vector search narrows the corpus to this many chunks. */
const RETRIEVAL_TOP_K = 40;
const MAX_NODES = 30;
const MAX_EDGES = 60;

const NODE_LAYERS = new Set(["foundation", "core", "branch"]);
const EDGE_RELATIONS = new Set([
  "prerequisite",
  "causal",
  "contrast",
  "part_of",
]);

interface GroundedChunk {
  id: string;
  text: string;
  chapter: string | null;
  source_title: string;
}

interface RawMapNode {
  name?: unknown;
  layer?: unknown;
  description?: unknown;
  citations?: unknown;
}

interface RawMapEdge {
  from?: unknown;
  to?: unknown;
  relation?: unknown;
  citations?: unknown;
}

interface RawMap {
  nodes?: RawMapNode[];
  edges?: RawMapEdge[];
}

interface StoredNode {
  id: string;
  name: string;
  layer: string;
  description: string | null;
  citations: string[];
}

interface StoredEdge {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  citations: string[];
}

/**
 * Pick the chunks the skeleton is built from. Small corpora are used whole so
 * no part of the field is silently skipped; larger ones are narrowed by
 * vector search on the fixed question, ranked by similarity.
 */
async function gatherChunks(
  env: Env,
  projectId: string,
): Promise<GroundedChunk[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.text, c.chapter, s.title AS source_title
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
      WHERE c.project_id = ?
      ORDER BY s.created_at ASC, c.idx ASC`,
  )
    .bind(projectId)
    .all<GroundedChunk>();
  if (results.length <= ALL_CHUNKS_LIMIT) return results;

  const [questionVector] = await embed(env, [PHASE1_QUESTION]);
  const matches = await env.VECTORIZE.query(questionVector, {
    topK: 100,
    returnMetadata: "none",
  });
  const byId = new Map(results.map((row) => [row.id, row]));
  const ranked: GroundedChunk[] = [];
  for (const match of matches.matches) {
    const row = byId.get(match.id);
    if (row) ranked.push(row);
    if (ranked.length >= RETRIEVAL_TOP_K) break;
  }
  // If vector search found nothing for this project, fall back to the first
  // chunks in document order rather than building a map from nothing.
  return ranked.length > 0 ? ranked : results.slice(0, RETRIEVAL_TOP_K);
}

/**
 * Resolve model citations to chunk ids. The model cites short labels (C1,
 * C2, ...); raw chunk ids are also accepted in case a model echoes those.
 * Anything else is not a citation and is dropped.
 */
function resolveCitations(
  value: unknown,
  resolver: Map<string, string>,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = resolver.get(item.trim());
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Short per-request labels (C1, C2, ...) stand in for chunk UUIDs in the
 * prompt. Models copy short labels reliably; at corpus scale they mangle
 * raw UUIDs, which silently breaks citation matching.
 */
function buildPhase1Messages(chunks: GroundedChunk[]) {
  const corpus = chunks
    .map(
      (chunk, i) =>
        `[C${i + 1}] ${chunk.chapter ?? chunk.source_title}\n${chunk.text}`,
    )
    .join("\n\n");
  return [
    {
      role: "system" as const,
      content:
        "あなたは学習支援システムの知識構造化エンジンです。与えられた資料チャンクだけに基づいて、分野の知識の骨格を構造化JSONで出力します。資料に書かれていないことは書かず、一般知識で補いません。すべてのノードとエッジには根拠となるチャンクのラベル（C1、C2 など）を citations に必ず含め、根拠を示せない概念は出力しません。出力はJSONオブジェクトのみとし、前置きや説明文は付けません。",
    },
    {
      role: "user" as const,
      content: `質問：${PHASE1_QUESTION}

資料チャンク（各チャンクは [ラベル] 章パス の見出し付き）:

${corpus}

出力形式（JSON）:
{
  "nodes": [
    {"name": "概念名", "layer": "foundation" | "core" | "branch", "description": "資料に基づく1〜2文の説明", "citations": ["C1"]}
  ],
  "edges": [
    {"from": "概念名", "to": "概念名", "relation": "prerequisite" | "causal" | "contrast" | "part_of", "citations": ["C1"]}
  ]
}
citations にはチャンクのラベル（C1、C2 など）をそのまま書くこと。
layer: foundation=他の概念の前提になる土台、core=中核、branch=応用・派生の枝葉。
relation: prerequisite=fromがtoの前提、causal=fromがtoに因果的に影響する、contrast=対比、part_of=fromがtoの一部。
ノードは5〜20個に絞ること。edges の from/to は nodes の name と完全に一致させること。`,
    },
  ];
}

/** Validate the model's map against the grounding rules. */
function validateMap(
  raw: RawMap,
  chunks: GroundedChunk[],
): { nodes: StoredNode[]; edges: StoredEdge[]; droppedNodes: number; droppedEdges: number } {
  const resolver = new Map<string, string>();
  chunks.forEach((chunk, i) => {
    resolver.set(`C${i + 1}`, chunk.id);
    resolver.set(chunk.id, chunk.id);
  });
  const nodes: StoredNode[] = [];
  const idByName = new Map<string, string>();
  let droppedNodes = 0;

  for (const rawNode of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const name = typeof rawNode.name === "string" ? rawNode.name.trim() : "";
    const citations = resolveCitations(rawNode.citations, resolver);
    if (!name || idByName.has(name) || citations.length === 0) {
      droppedNodes += 1;
      continue;
    }
    const id = crypto.randomUUID();
    idByName.set(name, id);
    nodes.push({
      id,
      name,
      layer:
        typeof rawNode.layer === "string" && NODE_LAYERS.has(rawNode.layer)
          ? rawNode.layer
          : "core",
      description:
        typeof rawNode.description === "string" && rawNode.description.trim()
          ? rawNode.description.trim()
          : null,
      citations,
    });
    if (nodes.length >= MAX_NODES) break;
  }

  const edges: StoredEdge[] = [];
  let droppedEdges = 0;
  for (const rawEdge of Array.isArray(raw.edges) ? raw.edges : []) {
    const from = typeof rawEdge.from === "string" ? rawEdge.from.trim() : "";
    const to = typeof rawEdge.to === "string" ? rawEdge.to.trim() : "";
    const relation =
      typeof rawEdge.relation === "string" ? rawEdge.relation : "";
    const citations = resolveCitations(rawEdge.citations, resolver);
    const fromId = idByName.get(from);
    const toId = idByName.get(to);
    if (
      !fromId ||
      !toId ||
      fromId === toId ||
      !EDGE_RELATIONS.has(relation) ||
      citations.length === 0
    ) {
      droppedEdges += 1;
      continue;
    }
    edges.push({
      id: crypto.randomUUID(),
      from_node: fromId,
      to_node: toId,
      relation,
      citations,
    });
    if (edges.length >= MAX_EDGES) break;
  }

  return { nodes, edges, droppedNodes, droppedEdges };
}

interface CitationDetail {
  chunk_id: string;
  source_title: string;
  chapter: string | null;
}

async function citationDetails(
  env: Env,
  citationIds: string[],
): Promise<Map<string, CitationDetail>> {
  const details = new Map<string, CitationDetail>();
  if (citationIds.length === 0) return details;
  const placeholders = citationIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT c.id AS chunk_id, s.title AS source_title, c.chapter
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
      WHERE c.id IN (${placeholders})`,
  )
    .bind(...citationIds)
    .all<CitationDetail>();
  for (const row of results) details.set(row.chunk_id, row);
  return details;
}

async function readMap(env: Env, projectId: string) {
  const { results: nodeRows } = await env.DB.prepare(
    "SELECT id, name, layer, description, citations FROM knowledge_nodes WHERE project_id = ? ORDER BY name ASC",
  )
    .bind(projectId)
    .all<{ id: string; name: string; layer: string; description: string | null; citations: string }>();
  const { results: edgeRows } = await env.DB.prepare(
    "SELECT id, from_node, to_node, relation, citations FROM knowledge_edges WHERE project_id = ?",
  )
    .bind(projectId)
    .all<{ id: string; from_node: string; to_node: string; relation: string; citations: string }>();

  const allCitations = new Set<string>();
  for (const row of [...nodeRows, ...edgeRows]) {
    for (const id of JSON.parse(row.citations) as string[]) allCitations.add(id);
  }
  const details = await citationDetails(env, [...allCitations]);
  const resolve = (ids: string[]) =>
    ids.map((id) => details.get(id) ?? { chunk_id: id, source_title: "", chapter: null });

  return {
    nodes: nodeRows.map((row) => ({
      id: row.id,
      name: row.name,
      layer: row.layer,
      description: row.description,
      citations: resolve(JSON.parse(row.citations) as string[]),
    })),
    edges: edgeRows.map((row) => ({
      id: row.id,
      from_node: row.from_node,
      to_node: row.to_node,
      relation: row.relation,
      citations: resolve(JSON.parse(row.citations) as string[]),
    })),
  };
}

// Phase 1: build (or rebuild) the knowledge map for a project.
phases.post("/:id/phases/1", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const chunks = await gatherChunks(c.env, projectId);
  if (chunks.length === 0) {
    return c.json(
      {
        error: "no_sources",
        message: "Phase 1 needs at least one ingested source (Phase 0) first",
      },
      400,
    );
  }

  let raw: RawMap;
  try {
    raw = await chatJSON<RawMap>(c.env, buildPhase1Messages(chunks));
  } catch (error) {
    console.error("phase 1 generation failed", error);
    return c.json(
      { error: "phase1_generation_failed", message: errorMessage(error) },
      502,
    );
  }

  const { nodes, edges, droppedNodes, droppedEdges } = validateMap(raw, chunks);
  if (nodes.length === 0) {
    return c.json(
      {
        error: "phase1_no_grounded_nodes",
        message: `The model returned no node with a valid citation to the provided chunks; nothing was stored (raw nodes: ${Array.isArray(raw.nodes) ? raw.nodes.length : 0}, dropped: ${droppedNodes})`,
      },
      502,
    );
  }

  // Rebuilding replaces the previous map atomically.
  await c.env.DB.batch([
    c.env.DB
      .prepare("DELETE FROM knowledge_edges WHERE project_id = ?")
      .bind(projectId),
    c.env.DB
      .prepare("DELETE FROM knowledge_nodes WHERE project_id = ?")
      .bind(projectId),
    ...nodes.map((node) =>
      c.env.DB
        .prepare(
          `INSERT INTO knowledge_nodes (id, project_id, name, layer, description, citations)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          node.id,
          projectId,
          node.name,
          node.layer,
          node.description,
          JSON.stringify(node.citations),
        ),
    ),
    ...edges.map((edge) =>
      c.env.DB
        .prepare(
          `INSERT INTO knowledge_edges (id, project_id, from_node, to_node, relation, citations)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          edge.id,
          projectId,
          edge.from_node,
          edge.to_node,
          edge.relation,
          JSON.stringify(edge.citations),
        ),
    ),
    c.env.DB
      .prepare(
        "UPDATE projects SET phase = 1, updated_at = datetime('now') WHERE id = ? AND phase < 1",
      )
      .bind(projectId),
  ]);

  const map = await readMap(c.env, projectId);
  return c.json({
    map,
    meta: {
      chunks_used: chunks.length,
      dropped_nodes: droppedNodes,
      dropped_edges: droppedEdges,
    },
  });
});

// Phase 1: read the stored knowledge map.
phases.get("/:id/phases/1", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);
  const map = await readMap(c.env, projectId);
  return c.json({ map });
});

// Phase 2: detect real controversies across sources. If none exist in the
// sources, return none. Never fabricate disagreements.
phases.post("/:id/phases/2", (c) =>
  c.json(
    notImplemented(
      "detect conflicting claims across sources, save controversies with positions and citations",
    ),
    501,
  ),
);

// Phase 3a: generate 10 questions + model answers + rubrics.
// Model answers stay server-side; the client receives questions only.
phases.post("/:id/phases/3/questions", (c) =>
  c.json(
    notImplemented(
      "generate questions covering concepts, causality, application, controversies; store model answers in D1 only",
    ),
    501,
  ),
);

// Phase 3b: submit an answer. The client must have sources locked
// (closed book). Grading returns missing points and shallow points,
// and records new gaps.
phases.post("/:id/phases/3/grade", (c) =>
  c.json(
    notImplemented(
      "grade one attempt against its rubric and model answer; save grade; open gaps for missing/shallow points",
    ),
    501,
  ),
);

// Phase 4: list open gaps for a project; a gap closes only via a retest.
phases.get("/:id/gaps", (c) =>
  c.json(notImplemented("list gaps from D1 by status"), 501),
);
