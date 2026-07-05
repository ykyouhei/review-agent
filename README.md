# review-agent

CI非依存・エージェンティックなPRコードレビューCLI。CodeRabbit等の外部SaaSが使えない環境向けに、自社のCIと自社契約のLLM APIだけで完結します。

- **リポジトリ全体の文脈でレビュー** — diffだけでなく、エージェントがRead/Grep/Globで既存実装・呼び出し元・慣習を自分で探索してから判断します
- **ナレッジ蓄積** — レビュー観点やリポジトリ理解を[OKF (Open Knowledge Format)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)のMarkdownとしてリポジトリ内に蓄積し、レビュー時に参照します
- **プラガブル** — エージェントSDK (Claude Agent SDK / Copilot SDK) とVCS (CodeCommit / GitHub) を設定で切替。GitLabはPhase 2
- **どのCIでも動く** — CodeBuild / Codemagic / GitHub Actions などで `review-agent review` を1行足すだけ

設計の背景と詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## セットアップ

```bash
npm install && npm run build

# agent: claude の場合
export ANTHROPIC_API_KEY=sk-ant-...        # CIのシークレット機構で注入する

# agent: copilot の場合 (Copilotサブスクリプションのあるアカウント)
export COPILOT_GITHUB_TOKEN=ghp_...        # GH_TOKEN / GITHUB_TOKEN でも可
```

対象リポジトリのルートに `.review-agent.yml` を置きます（すべて省略可、下記はデフォルト値）:

```yaml
agent: claude            # claude | copilot
vcs: codecommit          # codecommit | github | gitlab
model: claude-sonnet-5   # agent: copilot の場合はCopilot側のモデルID (例: gpt-5, claude-sonnet-4.5)
language: ja             # レビューコメントの言語
review:
  maxComments: 10        # 1回のレビューで投稿するコメント数の上限
  minSeverity: minor     # info | minor | major | critical
  minConfidence: 0.7     # これ未満の確信度の指摘は破棄
  ignore: []             # 例: ["**/*.lock", "dist/**"]
  # guidelines: |        # プロンプトに追加するレビュー指示
knowledge:
  path: .review-agent/knowledge
codecommit:
  # repositoryName: my-app   # CIから自動検出できない場合に指定
  # region: ap-northeast-1
github:
  # repository: owner/repo   # CIから自動検出できない場合に指定
  # baseUrl: https://ghe.example.com/api/v3   # GitHub Enterprise Server
```

## 使い方

```bash
# PRをレビューしてコメント投稿 (PR番号・リポジトリはCI環境変数から自動検出)
review-agent review

# 明示指定・投稿せず結果だけ見る
review-agent review --pr 123 --repo my-app --dry-run

# ローカルの作業ツリーをセルフレビュー (VCS API不要)
review-agent review --local --base main

# ナレッジ基盤の初期化 / エージェントによるリポジトリwiki生成
review-agent knowledge init
review-agent knowledge wiki
```

PR番号の自動検出: CodeBuild (`CODEBUILD_WEBHOOK_TRIGGER=pr/N`)、Codemagic (`CM_PULL_REQUEST_NUMBER`)、GitHub Actions、GitLab CI。どのCIでも `REVIEW_AGENT_PR` / `REVIEW_AGENT_REPO` で明示できます。

## CIへの組み込み例

### AWS CodeBuild (CodeCommit)

buildspec.yml:

```yaml
version: 0.2
phases:
  install:
    commands:
      - npm ci
  build:
    commands:
      # PRイベントで起動するよう CodeCommit → EventBridge → CodeBuild を設定し、
      # PULL_REQUEST_ID を環境変数で渡す (webhookトリガならpr/Nから自動検出)
      - npx review-agent review
```

CodeBuildのサービスロールに必要なIAM権限:

```json
{
  "Effect": "Allow",
  "Action": [
    "codecommit:GetPullRequest",
    "codecommit:GetCommentsForPullRequest",
    "codecommit:PostCommentForPullRequest"
  ],
  "Resource": "arn:aws:codecommit:*:*:my-app"
}
```

`ANTHROPIC_API_KEY` はSecrets Manager / Parameter Store経由で注入してください。

### Codemagic

```yaml
scripts:
  - name: PR review
    script: npx review-agent review --pr $CM_PULL_REQUEST_NUMBER
```

### GitHub Actions (vcs: github)

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx review-agent review
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

PR番号・リポジトリはActionsの環境変数から自動検出されます。diffと変更ファイル一覧はGitHub APIから取得するため、shallow checkoutのままで動作します（エージェントのリポジトリ探索用にcheckoutは必要です）。

## ナレッジ運用

```
.review-agent/knowledge/
  index.md          # 自動生成の目次 (プロンプトにはこれだけ注入される)
  wiki/             # リポジトリ理解 — `knowledge wiki` がエージェント探索で生成
  guidelines/       # 社内規約・レビュー観点 — 人間がPRで追加・更新
  review-notes/     # 過去レビューの知見 (Phase 2で自動蓄積予定)
```

ナレッジはコードと同じPRフローでレビューされるため、品質ゲートを既存のレビュー文化に相乗りできます。`knowledge wiki` はリリース毎などの節目で再実行して鮮度を保ってください。

## 開発

```bash
npm run typecheck && npm test    # 型チェック + ユニットテスト
npm run dev -- review --local --dry-run   # 手元で実行
```
