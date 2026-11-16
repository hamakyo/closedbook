import { Hono } from "hono";
import type { Env } from "../env";

/** Projects: one field of study each. Basic CRUD backed by D1. */
export const projects = new Hono<{ Bindings: Env }>();

projects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM projects ORDER BY created_at DESC",
  ).all();
  return c.json({ projects: results });
});

projects.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO projects (id, name, description) VALUES (?, ?, ?)",
  )
    .bind(id, body.name, body.description ?? null)
    .run();
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
    .bind(id)
    .first();
  return c.json({ project }, 201);
});

projects.get("/:id", async (c) => {
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
    .bind(c.req.param("id"))
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json({ project });
});
