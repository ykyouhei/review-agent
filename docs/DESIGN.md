# review-agent 設計ドキュメント

CI非依存・エージェンティックなPRコードレビューCLI。CodeRabbit等の外部SaaSが社内規約で利用できない環境向けに、自前のインフラ(CI + 自社契約のLLM API)だけで完結するレビューエージェントを提供する。

## 1. コンセプトと筋の評価

### 1.1 なぜこの構成が筋が良いか

**「リポジトリ全体の文脈を読むレビュー」はエージェントSDKならほぼ無料で手に入る。**
従来のdiff-onlyレビューボットに文脈を持たせるには、embeddingによるRAGパイプラインやコードグラフの構築が必要だった。エージェントSDK (Claude Agent SDK / Copilot SDK) はエージェント自身が Read / Grep / Glob 等のツールでリポジトリを探索するため、「この変更と似た既存実装はないか」「この関数の呼び出し元は影響を受けないか」をエージェントが必要に応じて自分で調べる。インデックス構築も鮮度管理も不要。

**OKF × リポジトリ内ナレッジはgitネイティブ。**
ナレッジがMarkdown + YAML frontmatter (OKF) でリポジトリ内にあるため、(1) エージェントが通常のファイルツールで読める、(2) ナレッジの更新が通常のPRフローで人間のレビューを通る、(3) ベクタDBや外部ストアの運用が不要、(4) ベンダーロックインがない。

**CLI + CI非依存は導入・運用コスト最小。**
CodeBuild / Codemagic / GitHub Actions などどのCIでも `npx review-agent review` を1行足すだけ。常駐サーバーもWebhook基盤も不要。認証はCI側の仕組み(CodeBuildならIAMロール)に乗る。

**SDK / VCS の抽象化は今なら現実的。**
Claude Agent SDK と Copilot SDK (2026年6月GA) は「プロンプト+ツール許可を渡すとエージェントループが回る」というほぼ同型のランタイムに収束した。抽象化はLLM呼び出しレベルではなく **「レビュータスク → 構造化されたFindings」というタスクレベル** で行う(`AgentRunner` interface)。エージェントループの中身はSDKに任せ、こちらは入出力の契約だけを規定する。

### 1.2 最大のリスク: ノイズ

自作レビューボットが死ぬ原因の第一位は「うるさくて誰も読まなくなる」こと。本設計では対策をパイプラインに組み込む:

| 対策 | 実装 |
|---|---|
| 確信度・重要度の閾値 | Findingに `severity` と `confidence` を必須で持たせ、設定値未満を破棄 |
| コメント数上限 | severity降順でソートし `maxComments` 件で打ち切り |
| 重複排除 | 各コメントに fingerprint (`file + category + 正規化タイトル` のハッシュ) をHTMLコメントとして埋め込み、再実行時に既存ボットコメントと照合してスキップ |
| 対象外ファイル | lockファイル・生成物などを `ignore` グロブで除外 |
| プロンプトでの抑制 | 「スタイル指摘はしない」「確信が持てない指摘は confidence を下げる」を明示 |

### 1.3 その他の設計判断

- **ナレッジの劣化対策**: プロンプトへは `index.md` のみ注入し、詳細はエージェントがオンデマンドで読む。蓄積が増えてもプロンプトサイズは一定。
- **ローカルモード**: `review --local` でVCS APIなしに作業ツリーのdiffをレビューできる。開発者のセルフレビュー用途と、VCS認証なしでのE2E検証を兼ねる。
- **CodeCommitファースト**: 社内の利用先がCodeCommit。認証はAWS標準の認証チェーン(CodeBuildのIAMロール)に乗るためトークン管理が不要。

## 2. アーキテクチャ

```
┌─────────────────────── CLI (commander) ───────────────────────┐
│  review [--pr N | --local] [--dry-run]   knowledge init|wiki  │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  core/orchestrator  │  パイプライン制御
                    └──┬───────┬───────┬──┘
          ┌────────────▼──┐ ┌──▼─────────────┐ ┌▼──────────────┐
          │ vcs/*         │ │ agent/*        │ │ knowledge/*   │
          │ VcsProvider   │ │ AgentRunner    │ │ OKF store     │
          │ - codecommit  │ │ - claude       │ │ - index生成    │
          │ - github(P2)  │ │ - copilot      │ │ - wiki生成     │
          │ - local diff  │ └────────────────┘ └───────────────┘
          └───────────────┘
```

### 2.1 レビューフロー

1. **文脈解決** — `--pr` / `--repo` 省略時は CI 環境変数から自動検出 (`vcs/detect.ts`)。CodeBuild: `CODEBUILD_WEBHOOK_TRIGGER=pr/N` 等。
2. **PR取得** — `VcsProvider` がPRメタデータ(タイトル・説明)とdiffを取得。ローカルモードでは `git diff <base>...HEAD` + 作業ツリー。
3. **ナレッジ読込** — `.review-agent/knowledge/index.md` があればプロンプトに注入。
4. **エージェント実行** — `AgentRunner.review(task)`。read-onlyツールのみ許可し、対象リポジトリをcwdとして探索させる。出力は構造化Findings。
5. **フィルタ** — 閾値・上限・ignore・fingerprint重複排除 (`core/filter.ts`)。
6. **投稿** — インラインコメント + サマリコメント。`--dry-run` はstdoutに整形出力。

### 2.2 主要インターフェース

```ts
// agent/types.ts — タスクレベルの抽象化。エージェントループはSDK側の責務
interface AgentRunner {
  review(task: ReviewTask): Promise<ReviewOutput>;
  generateWiki(task: WikiTask): Promise<void>;
}

interface ReviewTask {
  repoPath: string;          // エージェントが探索するルート
  title: string;
  description: string;
  diff: string;              // unified diff
  changedFiles: string[];
  knowledgeIndex?: string;   // OKF index.md の中身
  guidelines?: string;       // 追加のレビュー観点
  language: string;          // コメント言語
}

interface Finding {
  file: string;
  startLine: number;         // 変更後ファイルの行番号
  endLine: number;
  severity: 'info' | 'minor' | 'major' | 'critical';
  category: string;          // bug | security | performance | consistency | ...
  title: string;
  body: string;              // 根拠と修正案。探索で見つけた既存実装への言及を推奨
  suggestion?: string;       // 置換コード(あれば)
  confidence: number;        // 0..1
}

// vcs/types.ts
interface VcsProvider {
  getPullRequest(id: string): Promise<PullRequestInfo>;
  getExistingFingerprints(pr: PullRequestInfo): Promise<Set<string>>;
  postReview(pr: PullRequestInfo, review: ReviewToPost): Promise<void>;
}
```

### 2.3 Findingsの受け渡し

- **claude**: Claude Agent SDKの `outputFormat: { type: 'json_schema' }` によるネイティブ構造化出力を使用。失敗時は最終メッセージのテキストパース (`parseReviewOutput`) にフォールバック。
- **copilot**: Copilot SDKにjson_schema出力モードがないため、プロンプトで「最終メッセージに ```json フェンスで `{ summary, findings }` のみ出力せよ」と指示し、共通の `parseReviewOutput` でパースする。

### 2.4 Copilotバックエンドの対応関係

| 関心事 | Claude Agent SDK | Copilot SDK (`@github/copilot-sdk`) |
|---|---|---|
| セッション | `query({ prompt, options })` | `CopilotClient` → `createSession` → `sendAndWait` |
| リポジトリ探索 | `cwd` + Read/Grep/Glob | `workingDirectory` + 組込ツール |
| read-only制約 | `tools: ['Read','Grep','Glob']` | `onPermissionRequest` でdeny-by-default (readのみapprove) |
| wiki生成時の書込制限 | `canUseTool` でナレッジ配下のみ許可 | `onPermissionRequest` で `kind: 'write'` の `fileName` を検査 |
| システムプロンプト | `systemPrompt` | `systemMessage: { mode: 'append' }` (SDKのガードレール維持) |
| 認証 | `ANTHROPIC_API_KEY` / Claude Codeログイン | `COPILOT_GITHUB_TOKEN` 等 + Copilotサブスクリプション |

## 3. ナレッジ設計 (OKF)

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf): YAML frontmatter + Markdown本文、ディレクトリバンドル、相互リンク、自動生成index。

```
.review-agent/knowledge/
  index.md          # 自動生成インデックス。プロンプトにはこれだけ注入
  wiki/             # リポジトリ理解 (アーキテクチャ・モジュール構成・慣習)
                    #   `review-agent knowledge wiki` がエージェント探索で生成・更新
  guidelines/       # 社内規約・レビュー観点 (人間が記述)
  review-notes/     # 過去レビューの知見・抑制ルール (Phase 2で自動追記)
```

各エントリのfrontmatter:

```yaml
---
type: wiki | guideline | review-note
title: 認証モジュールの構成
tags: [auth, architecture]
timestamp: 2026-07-04T00:00:00Z
---
```

**ライフサイクル**: wiki は定期またはリリース毎に `knowledge wiki` で再生成。guidelines は人間がPRで追加。review-notes はエージェント/学習ループが追記し、通常のPRレビューで人間が承認する — ナレッジの品質ゲートを既存のコードレビュー文化に相乗りさせるのがポイント。

## 4. ロードマップ

| Phase | 内容 |
|---|---|
| **MVP (実装済み)** | CLI / Claude Agent SDKランナー / Copilot SDKランナー / CodeCommitプロバイダ / ローカルモード / ノイズ制御パイプライン / OKFナレッジ(init・wiki生成) |
| **Phase 2** | `learn` コマンド(ボットコメントへの👍👎・返信を収集し review-notes/ へ抑制ルールを蓄積)、GitHub / GitLab プロバイダ |
| **Phase 3** | インクリメンタルレビュー(前回レビュー済みコミット以降のみ)、複数リポジトリでのナレッジ共有(別リポジトリストア)、レビュー品質メトリクス(指摘の採用率) |

## 5. セキュリティ・運用上の注意

- エージェントに許可するツールは **read-only のみ** (Read / Grep / Glob / 読み取り系git)。コードの書き換え・任意コマンド実行は許可しない。
- LLM APIキー (`ANTHROPIC_API_KEY`) とVCS認証はCIのシークレット機構で注入。コード・ログに出さない。
- PR本文やコード中のテキストはエージェントへの入力になるため、プロンプトインジェクションの可能性は残る。read-onlyツール制限とコメント投稿のみという出力面の制約で影響範囲を「変なコメントが付く」までに限定している。
