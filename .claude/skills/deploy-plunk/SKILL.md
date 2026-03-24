# Deploy Plunk Fork

部署 hanamizuki/plunk fork 到 EC2 production（mail.mojoapp.ai）。

觸發時機：用戶說「部署」「deploy」「再部署一次」「部署新版」。

## 部署流程

### 1. 確認最新 commit

```bash
cd /Users/Hana/Developer/plunk-fork
git fetch origin deploy/custom
git log --oneline FETCH_HEAD -3
SHA=$(git rev-parse --short FETCH_HEAD)
```

### 2. 確認 CI 狀態

```bash
gh api "repos/hanamizuki/plunk/actions/runs?branch=deploy/custom&per_page=1" \
  --jq '.workflow_runs[0] | "\(.id) \(.status) \(.conclusion // "-") \(.head_sha[:7])"'
```

- 如果 `completed success` 且 SHA 匹配 → 直接部署
- 如果 `in_progress` → 背景追蹤等完成
- 如果沒觸發 → 手動觸發：
  ```bash
  gh api repos/hanamizuki/plunk/actions/workflows/250569854/dispatches \
    -X POST --input - <<< '{"ref":"deploy/custom"}'
  ```

### 3. 部署到 server

```bash
ssh -i ~/Sites/_Keys/hana2024.pem ubuntu@43.207.140.90 \
  "cd mojo-plunk-next && \
   sed -i \"s|image: ghcr.io/hanamizuki/plunk:sha-.*|image: ghcr.io/hanamizuki/plunk:sha-$SHA|\" docker-compose.yml && \
   docker compose pull plunk && \
   docker compose up -d plunk"
```

### 4. 驗證

```bash
ssh -i ~/Sites/_Keys/hana2024.pem ubuntu@43.207.140.90 \
  "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep plunk-next-plunk"
```

## 回滾（換回官方版）

```bash
ssh -i ~/Sites/_Keys/hana2024.pem ubuntu@43.207.140.90 \
  "cd mojo-plunk-next && \
   sed -i 's|image: ghcr.io/hanamizuki/plunk:sha-.*|image: ghcr.io/useplunk/plunk:latest|' docker-compose.yml && \
   docker compose pull plunk && \
   docker compose up -d plunk"
```

## 架構資訊

- **Docker image**: `ghcr.io/hanamizuki/plunk:sha-<commit>`
- **CI workflow**: `.github/workflows/docker-publish.yml`（push 到 `deploy/custom` 或 `next` 自動觸發）
- **Server**: EC2 `43.207.140.90`，目錄 `~/mojo-plunk-next/`
- **Branch**: `deploy/custom` — 合併所有自訂修改，基於 upstream `next`
