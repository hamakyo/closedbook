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
 * Phase 0, Phase 1 and Phase 2 are implemented; the rest remain stubs (501).
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
/** Above the limit, retrieval narrows the corpus to at most this many. */
const SELECTION_CAP = 48;
/**
 * Retrieval queries for large corpora: the fixed question plus one query per
 * facet of the skeleton (foundations, principles, framework, applications).
 * A single query biases the selection toward its own phrasing; several
 * queries, merged by best score, cover the field more evenly.
 */
const RETRIEVAL_QUERIES = [
  PHASE1_QUESTION,
  "基礎となる概念、その定義と成り立ち",
  "重要な原則と、設計上の指針・トレードオフ",
  "全体の枠組みと、構成要素どうしの関係",
  "実際の応用例と、使われ方のパターン",
];
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
  source_id: string;
  idx: number;
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
 * no part of the field is silently skipped. Larger ones are narrowed by
 * vector search with several facet queries (best score per chunk wins), then
 * allocated across sources: every source first gets an equal floor of its
 * best-scoring chunks, and the remaining slots go to the highest scores
 * overall. Without the floor, one long or well-matching source can crowd out
 * the rest of the field and the skeleton silently loses whole chapters.
 */
/** All chunk rows of a project plus a best-score lookup for the queries. */
async function scoreChunks(
  env: Env,
  projectId: string,
  queries: string[],
): Promise<{ rows: GroundedChunk[]; scoreOf: (row: GroundedChunk) => number }> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.source_id, c.idx, c.text, c.chapter, s.title AS source_title
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
      WHERE c.project_id = ?
      ORDER BY s.created_at ASC, c.idx ASC`,
  )
    .bind(projectId)
    .all<GroundedChunk>();

  const scores = new Map<string, number>();
  if (results.length > ALL_CHUNKS_LIMIT) {
    const queryVectors = await embed(env, queries);
    for (const vector of queryVectors) {
      const matches = await env.VECTORIZE.query(vector, {
        topK: 100,
        returnMetadata: "none",
      });
      for (const match of matches.matches) {
        const previous = scores.get(match.id);
        if (previous === undefined || match.score > previous) {
          scores.set(match.id, match.score);
        }
      }
    }
  }
  // Chunks no query surfaced rank below every scored chunk.
  const scoreOf = (row: GroundedChunk): number => scores.get(row.id) ?? -1;
  return { rows: results, scoreOf };
}

async function gatherChunks(
  env: Env,
  projectId: string,
  queries: string[] = RETRIEVAL_QUERIES,
  selectionCap: number = SELECTION_CAP,
): Promise<GroundedChunk[]> {
  const { rows: results, scoreOf } = await scoreChunks(env, projectId, queries);
  if (results.length <= ALL_CHUNKS_LIMIT) return results;

  const bySource = new Map<string, GroundedChunk[]>();
  for (const row of results) {
    const group = bySource.get(row.source_id);
    if (group) group.push(row);
    else bySource.set(row.source_id, [row]);
  }

  const selected = new Set<string>();
  const floor = Math.max(1, Math.floor(selectionCap / bySource.size));
  for (const group of bySource.values()) {
    const ranked = [...group].sort(
      (a, b) => scoreOf(b) - scoreOf(a) || a.idx - b.idx,
    );
    for (const row of ranked.slice(0, floor)) selected.add(row.id);
  }
  if (selected.size < selectionCap) {
    // Stable sort: score ties keep document order (source order, then idx).
    const rest = results
      .filter((row) => !selected.has(row.id))
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    for (const row of rest) {
      if (selected.size >= selectionCap) break;
      selected.add(row.id);
    }
  }

  // Keep the prompt in document order regardless of selection order.
  return results.filter((row) => selected.has(row.id));
}

/**
 * Per-source selection for Phase 2: each source's own best-scoring chunks,
 * in document order. Detection runs per source because a debate lives in a
 * run of passages inside one source; a single mixed prompt over the whole
 * corpus makes the model report only the loudest debate and miss the rest.
 */
async function gatherChunksBySource(
  env: Env,
  projectId: string,
  queries: string[],
  perSourceCap: number,
): Promise<Map<string, GroundedChunk[]>> {
  const { rows, scoreOf } = await scoreChunks(env, projectId, queries);
  const bySource = new Map<string, GroundedChunk[]>();
  for (const row of rows) {
    const group = bySource.get(row.source_id);
    if (group) group.push(row);
    else bySource.set(row.source_id, [row]);
  }
  const selected = new Map<string, GroundedChunk[]>();
  for (const [sourceId, group] of bySource) {
    if (group.length <= perSourceCap) {
      selected.set(sourceId, group);
    } else {
      const top = [...group]
        .sort((a, b) => scoreOf(b) - scoreOf(a) || a.idx - b.idx)
        .slice(0, perSourceCap);
      const keep = new Set(top.map((row) => row.id));
      selected.set(
        sourceId,
        group.filter((row) => keep.has(row.id)),
      );
    }
  }
  return selected;
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
interface CorpusGroup {
  heading: string;
  items: { label: string; text: string }[];
}

/**
 * Group chunks by source under a heading per source, so the model sees the
 * corpus structure instead of one flat stream. A flat stream lets the model
 * quietly ignore whole sources that were retrieved for coverage.
 */
function groupChunks(chunks: GroundedChunk[]): CorpusGroup[] {
  const groups: CorpusGroup[] = [];
  const groupBySource = new Map<string, CorpusGroup>();
  chunks.forEach((chunk, i) => {
    let group = groupBySource.get(chunk.source_id);
    if (!group) {
      group = { heading: chunk.chapter ?? chunk.source_title, items: [] };
      groupBySource.set(chunk.source_id, group);
      groups.push(group);
    }
    group.items.push({ label: `C${i + 1}`, text: chunk.text });
  });
  return groups;
}

function corpusText(groups: CorpusGroup[]): string {
  return groups
    .map((group) =>
      [
        `=== ${group.heading} ===`,
        ...group.items.map((item) => `[${item.label}]\n${item.text}`),
      ].join("\n\n"),
    )
    .join("\n\n");
}

function buildPhase1Messages(chunks: GroundedChunk[]) {
  const groups = groupChunks(chunks);
  const corpus = corpusText(groups);
  const coverage =
    groups.length > 1
      ? `\n資料は次の${groups.length}つの部分から構成される。骨格は資料全体を覆うものでなければならない。各部分の中核概念を最低1つはノードに含め、特定の部分だけに偏らないこと。\n${groups.map((group) => `- ${group.heading}`).join("\n")}\n`
      : "";
  return [
    {
      role: "system" as const,
      content:
        "あなたは学習支援システムの知識構造化エンジンです。与えられた資料チャンクだけに基づいて、分野の知識の骨格を構造化JSONで出力します。資料に書かれていないことは書かず、一般知識で補いません。すべてのノードとエッジには根拠となるチャンクのラベル（C1、C2 など）を citations に必ず含め、根拠を示せない概念は出力しません。出力はJSONオブジェクトのみとし、前置きや説明文は付けません。",
    },
    {
      role: "user" as const,
      content: `質問：${PHASE1_QUESTION}
${coverage}
資料チャンク（=== の見出しが資料の部分の区切り、各チャンクは [ラベル] 付き）:

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
ノードは5〜25個に絞ること。edges の from/to は nodes の name と完全に一致させること。`,
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

  const sourceByChunk = new Map(
    chunks.map((chunk) => [chunk.id, chunk.source_id]),
  );
  const citedSources = new Set<string>();
  for (const item of [...nodes, ...edges]) {
    for (const id of item.citations) {
      const sourceId = sourceByChunk.get(id);
      if (sourceId) citedSources.add(sourceId);
    }
  }

  const map = await readMap(c.env, projectId);
  return c.json({
    map,
    meta: {
      chunks_used: chunks.length,
      sources_used: new Set(chunks.map((chunk) => chunk.source_id)).size,
      sources_cited: citedSources.size,
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

// ---------------------------------------------------------------------------
// Phase 2: controversies. Detection first (design memo §5): find claims in
// the sources that genuinely conflict, then structure them as cards with
// positions, evidence, and rebuttals. The anti-fabrication rule is a design
// principle (§2): a controversy is stored only when at least two positions
// each cite the provided chunks. When nothing real is found, the honest
// result is an empty list, stored as such — never invented disagreements.
// ---------------------------------------------------------------------------

const PHASE2_QUESTION =
  "この分野で現在、根本的な論争が3つあるとしたら、それぞれ何？ それぞれの立場の見解、根拠、反対する理由を説明して";

/** Retrieval facets for Phase 2: disagreements, criticism, trade-offs. */
const PHASE2_QUERIES = [
  PHASE2_QUESTION,
  "対立する見解、批判と反論",
  "トレードオフと、どちらを選ぶべきかの議論",
  "欠点・限界・問題点の指摘",
  "従来の手法への批判と、新しい提案",
  "conflicting approaches: arguments for and against, trade-offs",
  "criticism, drawbacks and limitations debated",
];

const MAX_CONTROVERSIES = 3;
const MAX_POSITIONS = 3;

interface RawPosition {
  stance?: unknown;
  claims?: unknown;
  evidence?: unknown;
  rebuttal?: unknown;
  citations?: unknown;
}

interface RawControversy {
  topic?: unknown;
  summary?: unknown;
  unresolved_reason?: unknown;
  positions?: RawPosition[];
}

interface RawControversies {
  controversies?: RawControversy[];
}

interface StoredPosition {
  stance: string;
  claims: string | null;
  evidence: string | null;
  rebuttal: string | null;
  citations: string[];
}

interface StoredControversy {
  id: string;
  topic: string;
  summary: string | null;
  unresolved: string | null;
  positions: StoredPosition[];
}

function buildPhase2Messages(chunks: GroundedChunk[]) {
  const groups = groupChunks(chunks);
  const corpus = corpusText(groups);
  const inventory =
    groups.length > 1
      ? `\n資料は次の${groups.length}つの部分から構成される。対立は部分どうしの間にも、部分の中にもありうる。\n${groups.map((group) => `- ${group.heading}`).join("\n")}\n`
      : "";
  return [
    {
      role: "system" as const,
      content:
        "あなたは学習支援システムの論争検出エンジンです。与えられた資料チャンクの中に実在する主張の対立だけを検出して、構造化JSONで出力します。資料に書かれていない対立を作り出してはいけません。一般知識で補いません。すべての立場には根拠となるチャンクのラベル（C1、C2 など）を citations に必ず含めます。対立が見つからない場合は空の配列を返すのが正しい出力です。出力はJSONオブジェクトのみとし、前置きや説明文は付けません。",
    },
    {
      role: "user" as const,
      content: `質問：${PHASE2_QUESTION}
${inventory}
検出の基準:
- 論争とは、同じ対象について両立しない主張が資料の中に実際に述べられているものだけを指す
- 教科書や解説書が「Aの支持者は〜と主張する」「一方でBでは〜」「批判者は〜と指摘する」のように両側の見解を紹介している場合、それも資料内に実在する論争として扱う。立場の文章が著者自身の主張である必要はない
- ただし、資料が片側の見解しか述べていない論点は論争にしない。推測で反対側を作らない
- 単なる用語の違いや、強調点の違いだけのものは対立ではない
- この資料の部分から最大で2件まで。本当に根本的なものだけを選ぶ。なければ0件でよい

資料チャンク（=== の見出しが資料の部分の区切り、各チャンクは [ラベル] 付き）:

${corpus}

出力形式（JSON）:
{
  "controversies": [
    {
      "topic": "論点",
      "summary": "対立の概要（1〜2文）",
      "positions": [
        {"stance": "立場の要約", "claims": "その立場の主張", "evidence": "資料に基づく根拠", "rebuttal": "相手の立場への反論", "citations": ["C1"]}
      ],
      "unresolved_reason": "なぜまだ決着していないか（資料から読み取れる範囲で）"
    }
  ]
}
citations にはチャンクのラベル（C1、C2 など）をそのまま書くこと。各立場に最低1つの引用が必須。`,
    },
  ];
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Validate detected controversies against the anti-fabrication rules. */
function validateControversies(
  raw: RawControversies,
  chunks: GroundedChunk[],
  cap: number = MAX_CONTROVERSIES,
): { controversies: StoredControversy[]; dropped: number } {
  const resolver = new Map<string, string>();
  chunks.forEach((chunk, i) => {
    resolver.set(`C${i + 1}`, chunk.id);
    resolver.set(chunk.id, chunk.id);
  });

  const controversies: StoredControversy[] = [];
  let dropped = 0;
  for (const rawItem of Array.isArray(raw.controversies)
    ? raw.controversies
    : []) {
    const topic = asText(rawItem.topic);
    const positions: StoredPosition[] = [];
    for (const rawPosition of Array.isArray(rawItem.positions)
      ? rawItem.positions
      : []) {
      const stance = asText(rawPosition.stance);
      const citations = resolveCitations(rawPosition.citations, resolver);
      if (!stance || citations.length === 0) continue;
      positions.push({
        stance,
        claims: asText(rawPosition.claims),
        evidence: asText(rawPosition.evidence),
        rebuttal: asText(rawPosition.rebuttal),
        citations,
      });
      if (positions.length >= MAX_POSITIONS) break;
    }
    // A controversy needs a topic and at least two genuinely cited sides.
    if (!topic || positions.length < 2) {
      dropped += 1;
      continue;
    }
    controversies.push({
      id: crypto.randomUUID(),
      topic,
      summary: asText(rawItem.summary),
      unresolved: asText(rawItem.unresolved_reason),
      positions,
    });
    if (controversies.length >= cap) break;
  }
  return { controversies, dropped };
}

/**
 * Merge step for Phase 2: per-source detection returns candidate cards;
 * this call only selects and merges them into the final at-most-three.
 * Citations travel as short K-labels over the union of cited chunks and
 * are resolved back to chunk ids server-side, so the merge cannot invent
 * grounding the candidates did not have.
 */
function buildPhase2MergeMessages(
  candidates: StoredControversy[],
  chunkById: Map<string, GroundedChunk>,
): {
  messages: { role: "system" | "user"; content: string }[];
  labelOf: Map<string, string>;
} {
  const labelOf = new Map<string, string>();
  const idByLabel = new Map<string, string>();
  for (const candidate of candidates) {
    for (const position of candidate.positions) {
      for (const id of position.citations) {
        if (!labelOf.has(id)) {
          const label = `K${labelOf.size + 1}`;
          labelOf.set(id, label);
          idByLabel.set(label, id);
        }
      }
    }
  }
  const legend = [...labelOf.entries()]
    .map(([id, label]) => {
      const chunk = chunkById.get(id);
      return `${label}: ${chunk?.chapter ?? chunk?.source_title ?? ""}`;
    })
    .join("\n");
  const cards = candidates
    .map((candidate, i) => {
      const positions = candidate.positions
        .map(
          (position) =>
            `  - 立場: ${position.stance}\n    主張: ${position.claims ?? ""}\n    根拠: ${position.evidence ?? ""}\n    反論: ${position.rebuttal ?? ""}\n    引用: ${position.citations.map((id) => labelOf.get(id)).join(", ")}`,
        )
        .join("\n");
      return `候補${i + 1}: ${candidate.topic}\n概要: ${candidate.summary ?? ""}\n未決着の理由: ${candidate.unresolved ?? ""}\n${positions}`;
    })
    .join("\n\n");
  const messages = [
    {
      role: "system" as const,
      content:
        "あなたは学習支援システムの論争編集エンジンです。資料の部分ごとに検出された論争候補から、最終的な論争カードを選定・統合します。候補にない論点や立場を新しく作ってはいけません。引用は提示された K ラベルだけを使い、各立場に最低1つ付けます。出力はJSONオブジェクトのみとし、前置きや説明文は付けません。",
    },
    {
      role: "user" as const,
      content: `次の論争候補から、分野の理解にとって最も根本的なものを最大で3件選び、重複する論点は1件に統合して出力してください。統合した場合は両方の候補の引用を残してください。

引用ラベルの対応（ラベル: 出典の章）:
${legend}

${cards}

出力形式（JSON）:
{
  "controversies": [
    {
      "topic": "論点",
      "summary": "対立の概要（1〜2文）",
      "positions": [
        {"stance": "立場の要約", "claims": "その立場の主張", "evidence": "資料に基づく根拠", "rebuttal": "相手の立場への反論", "citations": ["K1"]}
      ],
      "unresolved_reason": "なぜまだ決着していないか"
    }
  ]
}`,
    },
  ];
  return { messages, labelOf: idByLabel };
}

/** Rewrite K-label citations in a merge result back to chunk ids. */
function resolveMergeCitations(
  raw: RawControversies,
  idByLabel: Map<string, string>,
): RawControversies {
  const mapCitations = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === "string" && idByLabel.has(item)
            ? idByLabel.get(item)
            : item,
        )
      : value;
  return {
    controversies: (Array.isArray(raw.controversies)
      ? raw.controversies
      : []
    ).map((item) => ({
      ...item,
      positions: (Array.isArray(item.positions) ? item.positions : []).map(
        (position) => ({
          ...position,
          citations: mapCitations(position.citations),
        }),
      ),
    })),
  };
}

async function readControversies(env: Env, projectId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, topic, summary, unresolved, positions FROM controversies WHERE project_id = ? ORDER BY created_at ASC",
  )
    .bind(projectId)
    .all<{
      id: string;
      topic: string;
      summary: string | null;
      unresolved: string | null;
      positions: string;
    }>();

  const allCitations = new Set<string>();
  const parsed = results.map((row) => ({
    ...row,
    positions: JSON.parse(row.positions) as StoredPosition[],
  }));
  for (const row of parsed) {
    for (const position of row.positions) {
      for (const id of position.citations) allCitations.add(id);
    }
  }
  const details = await citationDetails(env, [...allCitations]);
  const resolve = (ids: string[]) =>
    ids.map(
      (id) =>
        details.get(id) ?? { chunk_id: id, source_title: "", chapter: null },
    );

  return parsed.map((row) => ({
    id: row.id,
    topic: row.topic,
    summary: row.summary,
    unresolved: row.unresolved,
    positions: row.positions.map((position) => ({
      stance: position.stance,
      claims: position.claims,
      evidence: position.evidence,
      rebuttal: position.rebuttal,
      citations: resolve(position.citations),
    })),
  }));
}

// Phase 2: detect (or re-detect) the controversies in a project's sources.
phases.post("/:id/phases/2", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id, phase FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string; phase: number }>();
  if (!project) return c.json({ error: "project not found" }, 404);
  if (project.phase < 1) {
    return c.json(
      {
        error: "phase_order",
        message: "Phase 2 requires Phase 1 (skeleton) to be completed first",
      },
      400,
    );
  }

  const bySource = await gatherChunksBySource(
    c.env,
    projectId,
    PHASE2_QUERIES,
    16,
  );
  const allChunks = [...bySource.values()].flat();
  if (allChunks.length === 0) {
    return c.json(
      {
        error: "no_sources",
        message: "Phase 2 needs at least one ingested source (Phase 0) first",
      },
      400,
    );
  }
  const chunkById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));

  // Detection runs per source, a few sources at a time. One source failing
  // must not sink the whole phase; it is counted and the rest still count.
  const sourceChunks = [...bySource.values()];
  const candidates: StoredControversy[] = [];
  let sourcesFailed = 0;
  for (let i = 0; i < sourceChunks.length; i += 3) {
    const batch = sourceChunks.slice(i, i + 3);
    const settled = await Promise.allSettled(
      batch.map(async (chunks) => {
        const raw = await chatJSON<RawControversies>(
          c.env,
          buildPhase2Messages(chunks),
        );
        return validateControversies(raw, chunks, 2).controversies;
      }),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") candidates.push(...result.value);
      else sourcesFailed += 1;
    }
  }
  if (sourcesFailed === sourceChunks.length) {
    return c.json(
      {
        error: "phase2_detection_failed",
        message: "controversy detection failed for every source",
      },
      502,
    );
  }

  // Few enough candidates need no merge call; more go through selection.
  let controversies: StoredControversy[];
  let dropped = 0;
  if (candidates.length <= MAX_CONTROVERSIES) {
    controversies = candidates;
  } else {
    try {
      const { messages, labelOf } = buildPhase2MergeMessages(
        candidates,
        chunkById,
      );
      const rawMerged = await chatJSON<RawControversies>(c.env, messages);
      const resolved = resolveMergeCitations(rawMerged, labelOf);
      const citedChunks = [...labelOf.values()]
        .map((id) => chunkById.get(id))
        .filter((chunk): chunk is GroundedChunk => chunk !== undefined);
      const validated = validateControversies(resolved, citedChunks);
      controversies = validated.controversies;
      dropped = validated.dropped;
    } catch (error) {
      console.error("phase 2 merge failed", error);
      return c.json(
        { error: "phase2_detection_failed", message: errorMessage(error) },
        502,
      );
    }
  }

  // Re-running replaces the previous findings atomically. An empty result is
  // a legitimate finding (no real disagreements in the sources) and is
  // stored the same way: as none.
  await c.env.DB.batch([
    c.env.DB
      .prepare("DELETE FROM controversies WHERE project_id = ?")
      .bind(projectId),
    ...controversies.map((item) =>
      c.env.DB
        .prepare(
          `INSERT INTO controversies (id, project_id, topic, summary, unresolved, positions)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          projectId,
          item.topic,
          item.summary,
          item.unresolved,
          JSON.stringify(item.positions),
        ),
    ),
    c.env.DB
      .prepare(
        "UPDATE projects SET phase = 2, updated_at = datetime('now') WHERE id = ? AND phase < 2",
      )
      .bind(projectId),
  ]);

  const stored = await readControversies(c.env, projectId);
  return c.json({
    controversies: stored,
    meta: {
      chunks_used: allChunks.length,
      sources_used: bySource.size,
      sources_failed: sourcesFailed,
      candidates: candidates.length,
      found: stored.length,
      dropped: dropped,
    },
  });
});

// Phase 2: read the stored controversies.
phases.get("/:id/phases/2", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);
  const controversies = await readControversies(c.env, projectId);
  return c.json({ controversies });
});

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
