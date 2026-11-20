# AGENTS.md

## 目的

見知らぬ学問分野を資料ベースの骨格・論争・資料ロック試験・理解の穴（Gap）追跡で学ぶセルフホスト型学習プラットフォーム（ClosedBook）のコードと設計の正本。Hono + Cloudflare Workers / D1 / R2 / Vectorize 上で動作する。

## 正本と生成物

- 正本：
  - アプリケーションコード・設定：`src/`、`cloudflare.config.ts`、`package.json`
  - データベーススキーマ：`db/schema.sql`（Cloudflare D1 / SQLite）
  - 設計ドキュメント：`docs/design-memo.md`、`README.md`
- 生成物（**手で編集しない**）：
  - `pnpm build`（`cf build`）の出力や `.wrangler/` 配下のローカル状態
  - D1 / R2 / Vectorize 上のランタイムデータ

## スキーマ

詳細は [db/schema.sql](db/schema.sql) と [docs/design-memo.md](docs/design-memo.md) を正とする。

- 主要テーブル（すべて `id TEXT PRIMARY KEY`、`PRAGMA foreign_keys = ON`）：
  - `projects`（`phase`: `0`=資料 / `1`=骨格 / `2`=論争 / `3`=テスト / `4`=穴）
  - `sources`（原本は R2 の `r2_key`、`kind`: `textbook` | `paper` | `slides` | `other`）
  - `chunks`（ページ・章メタデータ保持。埋め込みは Vectorize に `chunk.id` キーで保存）
  - `knowledge_nodes`（`layer`: `foundation` | `core` | `branch`、`citations` JSON） / `knowledge_edges`（`relation`: `prerequisite` | `causal` | `contrast` | `part_of`）
  - `controversies`（`positions` JSON）
  - `questions`（`tag`: `concept` | `causal` | `application` | `controversy`、`model_answer`・`rubric` はサーバー側秘匿、`gap_id` は再テスト問題のみ）
  - `attempts`（`locked`: `1`=資料ロック下で回答） / `grades`（`scores`・`missing_points`・`shallow_points`・`followup`）
  - `gaps`（`status`: `open` | `retesting` | `closed`。再テスト合格でのみ閉じる）
- 設計原則：
  - **Grounding 必須**：AI の出力はアップロード資料だけに基づき、出典引用を必須とする
  - **答えの秘匿**：`questions.model_answer` と `rubric` は採点完了まで API レスポンスに含めない
  - **資料ロック**：テスト回答中は資料閲覧・チャットを無効化する
  - **論争を捏造しない**：資料内に実在しない対立は作らない
  - **穴は再テスト合格でのみ閉じる**：直接 `closed` にする API は用意しない

## 更新の流れ

1. コード・スキーマ（`db/schema.sql`）・設計メモを編集する
2. スキーマを変えた場合はローカル D1 へ適用する（`pnpm db:local`）
3. 型チェックとビルドを確認する（`pnpm typecheck`、`pnpm build`）
4. commit & push する（本番反映が必要な場合は別途 `pnpm db:remote` / `pnpm deploy` を実行する）

## 禁止事項

- 秘密情報（`LLM_API_KEY`、Cloudflare のアカウントトークン等）や `.dev.vars` の commit（ローカルは `.dev.vars`、本番は `cf workers secrets update LLM_API_KEY` に置き、値自体は repo に書かない）
- 採点前に `model_answer` や `rubric` をクライアントへ返す変更
- 資料外の知識で水増ししたり、存在しない論争を捏造するプロンプト変更
- Gap を再テストなしに直接閉じるエンドポイントの追加
- 承認なしでの本番デプロイ（`pnpm deploy`）や本番 D1 スキーマ適用（`pnpm db:remote`）

## 除外・対象外

- 公開 repo のため、個人の学習資料原本・学習記録・API キー・個人情報はここに入れない。
- スキャン画像 PDF の OCR は対象外（テキスト抽出は MarkItDown による事前変換、またはテキスト主体 PDF の抽出を前提とする）。
- UI は現行構成（`package.json`・`README.md`・`docs/design-memo.md`）に従い、独自デザインシステムを増やさない。
