/**
 * Markdown-aware chunking for Phase 0 source ingestion.
 *
 * Input is always Markdown or plain text (PDFs are converted to Markdown by
 * Microsoft MarkItDown on the user's machine). We therefore keep the parser
 * small: ATX/setext headings define section boundaries, fenced code blocks are
 * never treated as headings, and long sections are split at paragraph
 * boundaries. If a single paragraph is still too long, it is split at a
 * sentence/newline/whitespace boundary so each chunk stays within the limit.
 */

export const MAX_CHUNK_CHARS = 1200;

export interface SourceChunk {
  text: string;
  chapter: string | null;
  page: number | null;
}

interface Section {
  path: string[];
  content: string;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

function openFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  const info = match[2];
  // A backtick fence's info string may not contain a backtick.
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length: match[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return (
    match !== null &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length
  );
}

function parseAtxHeading(line: string): { level: number; text: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!match) return null;
  const text = (match[2] ?? "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
  return { level: match[1].length, text };
}

function setextLevel(line: string): 1 | 2 | null {
  const match = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!match) return null;
  return match[1][0] === "=" ? 1 : 2;
}

/** Split section content into paragraphs, preserving fenced code blocks. */
function splitParagraphs(content: string): string[] {
  const lines = content.split("\n");
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let fence: Fence | null = null;

  const flush = () => {
    const paragraph = buffer.join("\n").trim();
    if (paragraph) paragraphs.push(paragraph);
    buffer = [];
  };

  for (const line of lines) {
    if (fence) {
      buffer.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const opened = openFence(line);
    if (opened) {
      if (buffer.some((entry) => entry.trim())) flush();
      fence = opened;
      buffer.push(line);
      continue;
    }

    if (!line.trim()) {
      flush();
    } else {
      buffer.push(line);
    }
  }

  flush();
  return paragraphs;
}

/** Find a natural cut point at or before `max`, falling back to a hard cut. */
function findCut(text: string, max: number): number {
  const limit = Math.min(max, text.length);
  const minUseful = Math.floor(max / 2);
  const candidates: number[] = [];

  const newline = text.lastIndexOf("\n", limit - 1);
  if (newline >= minUseful) candidates.push(newline);

  for (const mark of [".", "。", "!", "?", "！", "？", "；", ";"]) {
    const index = text.lastIndexOf(mark, limit - 1);
    if (index >= minUseful && index + 1 <= limit) candidates.push(index + 1);
  }

  const space = text.lastIndexOf(" ", limit - 1);
  if (space >= minUseful) candidates.push(space);

  let cut = candidates.length > 0 ? Math.max(...candidates) : limit;
  cut = Math.min(cut, text.length);

  // Do not split a surrogate pair in the middle.
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  }

  return Math.max(1, cut);
}

function splitLongParagraph(paragraph: string, max: number): string[] {
  let remaining = paragraph.trim();
  const pieces: string[] = [];

  while (remaining.length > max) {
    const cut = findCut(remaining, max);
    const piece = remaining.slice(0, cut).trimEnd();
    if (piece) pieces.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) pieces.push(remaining);
  return pieces;
}

function splitSection(content: string, max: number): string[] {
  const paragraphs = splitParagraphs(content);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    for (const piece of splitLongParagraph(paragraph, max)) {
      if (!piece) continue;

      if (!current) {
        current = piece;
      } else if (current.length + 2 + piece.length <= max) {
        current += `\n\n${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Chunk Markdown/plain text.
 *
 * Heading boundaries create sections; each chunk carries the full heading path
 * (e.g. "Chapter 1 > Section 2"). MarkItDown output has no page markers, so
 * page is always null.
 */
export function chunkMarkdown(input: string): SourceChunk[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let currentPath: string[] = [];
  let currentLines: string[] = [];
  let fence: Fence | null = null;

  const flushSection = () => {
    const content = currentLines.join("\n");
    if (content.trim()) sections.push({ path: currentPath, content });
    currentLines = [];
  };

  const setHeading = (level: number, text: string) => {
    if (!text) return;
    while (
      headingStack.length > 0 &&
      headingStack[headingStack.length - 1].level >= level
    ) {
      headingStack.pop();
    }
    headingStack.push({ level, text });
    currentPath = headingStack.map((heading) => heading.text);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fence) {
      currentLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const opened = openFence(line);
    if (opened) {
      fence = opened;
      currentLines.push(line);
      continue;
    }

    const atx = parseAtxHeading(line);
    if (atx) {
      flushSection();
      setHeading(atx.level, atx.text);
      continue;
    }

    const next = lines[i + 1];
    const level = next !== undefined ? setextLevel(next) : null;
    if (level !== null && line.trim() && !/^ {4}/.test(line)) {
      flushSection();
      setHeading(level, line.trim());
      i += 1; // consume the underline
      continue;
    }

    currentLines.push(line);
  }

  flushSection();

  const chunks: SourceChunk[] = [];
  for (const section of sections) {
    const chapter =
      section.path.length > 0 ? section.path.join(" > ") : null;
    for (const text of splitSection(section.content, MAX_CHUNK_CHARS)) {
      const trimmed = text.trim();
      if (trimmed) chunks.push({ text: trimmed, chapter, page: null });
    }
  }

  return chunks;
}
