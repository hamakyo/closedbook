import { Hono } from "hono";
import type { Env } from "./env";
import { projects } from "./routes/projects";
import { phases } from "./routes/phases";
import uiHtml from "./ui.html";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(uiHtml));

app.get("/api", (c) =>
  c.json({
    name: "closedbook",
    status: "scaffold",
    protocol: ["sources", "skeleton", "controversies", "test", "gaps"],
    docs: "https://github.com/hamakyo/closedbook",
  }),
);

app.get("/api/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true, db: "up" });
});

app.route("/api/projects", projects);
app.route("/api/projects", phases);

export default app;
