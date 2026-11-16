import { Hono } from "hono";
import type { Env } from "../env";

/**
 * The learning protocol. Each phase is a fixed step, in order:
 *   Phase 1  skeleton      -> knowledge map from the sources (grounded, cited)
 *   Phase 2  controversies -> real disagreements in the sources, never invented
 *   Phase 3  test          -> generate questions (answers kept server-side),
 *                             answer with sources locked, then grade for
 *                             what is missing and what is shallow
 *   Phase 4  gaps          -> tracked understanding gaps + retests
 *
 * All endpoints are stubs for now (501). See docs/design-memo.md for the spec.
 */
export const phases = new Hono<{ Bindings: Env }>();

const notImplemented = (todo: string) => ({ error: "not_implemented", todo });

// Phase 0: register a source file (original goes to R2, text is chunked,
// chunks are embedded into Vectorize). PDF text extraction is the known
// hard spot on Workers (128MB memory): use unpdf for text-based PDFs,
// or extract text client-side before upload. OCR is out of scope.
phases.post("/:id/sources", (c) =>
  c.json(
    notImplemented(
      "store original in R2, extract text, chunk, embed into Vectorize, save chunks to D1",
    ),
    501,
  ),
);

// Phase 1: build the knowledge map (nodes/edges with citations to chunks).
phases.post("/:id/phases/1", (c) =>
  c.json(
    notImplemented(
      "retrieve chunks, ask the core-consensus question, save knowledge_nodes/knowledge_edges",
    ),
    501,
  ),
);

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
