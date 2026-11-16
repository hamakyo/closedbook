# ClosedBook

ClosedBook は、見知らぬ学問分野を短期間で「本当に理解する」ための学習プロトコルを、そのまま実行できる形にしたセルフホスト型の学習プラットフォームです。

NotebookLM のようなツールは「開いた本」です。資料を入れて、要約を読んで、質問できる。ClosedBook は逆に「閉じた本（closed book = 資料持ち込み不可の試験）」です。資料に基づいて知識の骨格と論争を整理したら、資料を閉じて自力で答え、自分の理解の穴を暴きます。

> 状態：**叩き台（scaffold）**。プロジェクト CRUD とプロトコルの API スタブ、D1 スキーマまで実装済み。各フェーズの中身はこれから。設計の全体像は [docs/design-memo.md](docs/design-memo.md) を参照。

## 学習プロトコル

1. **Phase 0 — 資料ベース**：その分野の定番教科書・論文・授業資料をアップロードする。AI の回答は、この資料だけに基づく（grounding）。出典のない主張は出さない
2. **Phase 1 — 骨格**：「この分野の中核的な共通認識は何か。基礎概念・原則・全体の枠組みと、それらの関係を整理して」。要約ではなく知識マップを作り、どこが土台でどこが枝かを見る
3. **Phase 2 — 論争**：「根本的な論争が3つあるとしたら何か。各立場の見解・根拠・反論を」。資料に実在しない対立は捏造しない
4. **Phase 3 — テスト**：中核概念・因果関係・応用・論争を網羅する問題を10問生成（答えはサーバー側に秘匿）。**資料をロックした状態で自答**し、1問ずつ採点する。採点の主眼は正誤ではなく「抜けている重要な点」と「結論を覚えただけで理解していない箇所」
5. **Phase 4 — 穴の追跡**：採点で見つかった理解の穴（Gap）を記録し、次のセッションで再テストして閉じるまで追う

## 構成

すべて自分の Cloudflare アカウント上で動きます。運営者はいません。あなたの資料と学習記録が、誰かのサーバーに渡ることはありません。

| 役割 | サービス |
|---|---|
| API | Hono on Cloudflare Workers |
| リレーショナルデータ | D1（プロジェクト・問題・回答・採点・Gap） |
| 資料ファイルの原本 | R2 |
| ベクトル検索 | Vectorize |
| LLM | **BYOK**：自分の API キーを使う。OpenAI 互換エンドポイントなら公式・ゲートウェイを問わない |

## クイックスタート

前提：Node.js、pnpm、Cloudflare アカウント。

```bash
git clone https://github.com/hamakyo/closedbook.git
cd closedbook
pnpm install

# Cloudflare 側のリソースを作成
pnpm exec wrangler d1 create closedbook
pnpm exec wrangler r2 bucket create closedbook-sources
pnpm exec wrangler vectorize create closedbook-chunks --dimensions=1536 --metric=cosine
# → wrangler.toml の database_id を、発行された実 ID に書き換える

# スキーマ適用
pnpm db:local    # ローカル確認用
pnpm db:remote   # 本番用

# LLM のキー（自分のもの）を設定
cp .dev.vars.example .dev.vars   # ローカル用：LLM_API_KEY を記入
pnpm exec wrangler secret put LLM_API_KEY   # 本番用

pnpm dev         # ローカル起動
pnpm deploy      # 自分の Cloudflare にデプロイ
```

エンドポイントやモデルは `wrangler.toml` の `[vars]` で変更できます（`LLM_BASE_URL` / `LLM_MODEL` / `EMBEDDING_MODEL`）。埋め込みモデルの次元を変えたら、Vectorize インデックスの `--dimensions` も合わせてください。

自分だけが使う前提なら、認証は Cloudflare Access を前に置くのが簡単です。

## 既知の難所

- **PDF のテキスト抽出**：Workers はメモリ 128MB のため、pdf.js 系の解析は重い。テキスト主体の PDF は `unpdf` で処理する想定。重い PDF はブラウザ側で抽出してから送る。スキャン画像 PDF の OCR は対象外

## ロードマップ（MVP）

- [x] プロジェクト CRUD / D1 スキーマ / API スタブ
- [ ] Phase 0：資料取り込み（R2 保存・チャンク化・Vectorize 埋め込み）
- [ ] Phase 1：知識マップ生成（出典つき）
- [ ] Phase 2：論争の検出と提示
- [ ] Phase 3：問題生成・資料ロック回答・採点（抜け／浅さ）
- [ ] Phase 4：Gap 一覧と再テスト
- [ ] 最小の Web UI

## ライセンス

MIT License. See [LICENSE](LICENSE).
