---
name: deploy-plunk
description: Deploy Plunk Fork
---

# Deploy Plunk Fork

部署 hanamizuki/plunk fork 到 EC2 production（mail.mojoapp.ai）。

觸發時機：用戶說「部署」「deploy」「再部署一次」「部署新版」。

## 環境資訊（已於 2026-05-25 對齊實況）

- **Production EC2**：`13.193.173.27`（mojo production + Ghost）
- **SSH key**：`~/.secrets/aws-ec2/hana-prod.pem`
- **目錄**：`~/mojo-plunk/`
- **Compose service**：`app`（container `mojo-plunk-app`）
- **Docker image**：`ghcr.io/hanamizuki/plunk:sha-<commit>`
- **CI workflow**：`.github/workflows/docker-publish.yml`（push 到 `next` 或 `deploy/custom` 自動觸發，亦可 `workflow_dispatch`）
- **Branch**：`deploy/custom` — 基於 upstream release tag，疊上 fork 專屬的 CI glue + 已選功能（目前 #331 send test email、#394 preview-as-segment）
- 對外網域：`mail.mojoapp.ai`（dashboard, 80）、`api.mail.mojoapp.ai`（API, 8080），透過 Caddy reverse proxy
- Infra（`mojo-plunk-postgres` / `redis` / `minio` / `ntfy`）部署時不動，只換 `app`

> 舊紀錄曾用 `43.207.140.90` / `~/Sites/_Keys/hana2024.pem` / `mojo-plunk-next`，皆為搬遷前的過時資料，勿用。

## 部署流程

### 1. 確認最新 commit

```bash
cd /Users/Hana/Agents/nana/repos/plunk-fork
git fetch origin deploy/custom
git log --oneline FETCH_HEAD -3
SHA=$(git rev-parse --short FETCH_HEAD)
```

### 2. 確認 CI build 狀態

```bash
gh api "repos/hanamizuki/plunk/actions/runs?branch=deploy/custom&per_page=1" \
  --jq '.workflow_runs[0] | "\(.id) \(.status) \(.conclusion // "-") \(.head_sha[:7])"'
```

- `completed success` 且 SHA 匹配 → 直接部署
- `in_progress` → 背景追蹤等完成
- 沒觸發 → 手動觸發：
  ```bash
  gh workflow run docker-publish.yml --repo hanamizuki/plunk --ref deploy/custom
  ```

### 3. 備份（部署前必做）

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "mkdir -p ~/backups/plunk && \
   docker exec mojo-plunk-postgres pg_dump -U plunk -d plunk | gzip > ~/backups/plunk/plunk-pre-${SHA}-${TS}.sql.gz && \
   cd ~/mojo-plunk && cp docker-compose.yml docker-compose.yml.bak-${TS}"
```

### 4. 部署到 server

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "cd ~/mojo-plunk && \
   sed -i \"s|image: ghcr.io/.*plunk:.*|image: ghcr.io/hanamizuki/plunk:sha-$SHA|\" docker-compose.yml && \
   docker compose pull app && \
   docker compose up -d app"
```

容器啟動時 `docker-entrypoint` 會自動跑 `prisma migrate deploy`（forward-only；確認過 migration 為 additive 才部署）。

### 5. 驗證

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep mojo-plunk-app"
curl -s -o /dev/null -w '%{http_code}\n' https://api.mail.mojoapp.ai/templates
curl -s -o /dev/null -w '%{http_code}\n' https://mail.mojoapp.ai/
```

## 回滾（換回官方版）

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "cd ~/mojo-plunk && \
   sed -i 's|image: ghcr.io/.*plunk:.*|image: ghcr.io/useplunk/plunk:0.11.0|' docker-compose.yml && \
   docker compose pull app && \
   docker compose up -d app"
```

DB 若已被 `prisma migrate deploy` 改寫，回滾 schema 需 restore 備份：
`gunzip -c ~/backups/plunk/plunk-pre-*.sql.gz | docker exec -i mojo-plunk-postgres psql -U plunk -d plunk`
