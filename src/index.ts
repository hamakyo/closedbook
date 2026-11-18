import { Hono } from "hono";
import type { Env } from "./env";
import { projects } from "./routes/projects";
import { phases } from "./routes/phases";
import uiHtml from "./ui.html";
import themingCss from "./assets/css_variables.css";
import fundamentalCss from "./assets/fundamental-styles.css";

const app = new Hono<{ Bindings: Env }>();

// Access lock. The content this app stores is derived from the user's own
// study materials (copyrighted books among them), so it must never be
// world-readable. Fail closed: without a UI_PASSWORD secret the app
// refuses everything; with one, every route requires Basic auth.
app.use("*", async (c, next) => {
  const expected = c.env.UI_PASSWORD;
  if (!expected) {
    return c.text(
      "ClosedBook is locked. Set a password to enable access: wrangler secret put UI_PASSWORD",
      503,
    );
  }
  const header = c.req.header("Authorization") ?? "";
  let ok = false;
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice("Basic ".length));
      const password = decoded.slice(decoded.indexOf(":") + 1);
      ok = password === expected;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="ClosedBook"' },
    });
  }
  await next();
});

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
