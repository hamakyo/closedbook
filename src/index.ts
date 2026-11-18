import { Hono } from "hono";
import type { Env } from "./env";
import { projects } from "./routes/projects";
import { phases } from "./routes/phases";
import uiHtml from "./ui.html";
import themingCss from "./assets/css_variables.css";
import fundamentalCss from "./assets/fundamental-styles.css";

const app = new Hono<{ Bindings: Env }>();

// Access control lives at the edge: a Cloudflare Access application
// (self-hosted, "ClosedBook") fronts this hostname and only allows the
// owner's email addresses via one-time PIN. The content this app stores
// is derived from the owner's study materials (copyrighted books among
// them) and must never be world-readable, so do not remove the Access
// application without putting another gate in its place.
app.get("/", (c) => c.html(uiHtml));

const cssHeaders = {
  "Content-Type": "text/css; charset=utf-8",
  "Cache-Control": "public, max-age=86400",
};
app.get("/assets/css_variables.css", (c) => c.body(themingCss, 200, cssHeaders));
app.get("/assets/fundamental-styles.css", (c) =>
  c.body(fundamentalCss, 200, cssHeaders),
);

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
