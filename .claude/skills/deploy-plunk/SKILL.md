---
name: deploy-plunk
description: Deploy Plunk Fork
---

# Deploy Plunk Fork

部署 hanamizuki/plunk fork 到 EC2 production（mail.mojoapp.ai）。

觸發時機：用戶說「部署」「deploy」「再部署一次」「部署新版」「plunk ops」「plunk 設定」。

## 環境資訊（已於 2026-05-25 對齊實況）

- **Production EC2**：`13.193.173.27`（mojo production + Ghost）
- **SSH key**：`~/.secrets/aws-ec2/hana-prod.pem`
- **目錄**：`~/mojo-plunk/`
- **Compose service**：`app`（container `mojo-plunk-app`）
- **Docker image**：`ghcr.io/hanamizuki/plunk:sha-<commit>`
- **CI workflow**：`.github/workflows/docker-publish.yml`（push 到 `next` 或 `deploy/custom` 自動觸發，亦可 `workflow_dispatch`）
- **Branch**：`deploy/custom` — 基於 upstream release tag，疊上 fork 專屬 patch
- **Upstream**：`useplunk/plunk`，main branch 為 `next`，最新 release tag 為基底
- 對外網域：`plunk.hanamizuki.tw`（dashboard, 80）、`api.plunk.hanamizuki.tw`（API, 8080），透過 Caddy reverse proxy。舊 API domain `api.mail.mojoapp.ai` 在 Caddy 保留向後相容
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

### 2.5 v0.12.0 migration pre-check（只有首次部署 v0.12.0 那次要跑）

`20260615120000_normalize_contact_emails` 會合併同信箱大小寫變體的 contacts 並 **DELETE** 重複列。
它有兩個已知風險，部署前用下面兩句確認實際資料不會踩到（2026-07-31 實測都是 0）：

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "docker exec mojo-plunk-postgres psql -U plunk -d plunk -c \"
WITH map AS (
  SELECT id AS dup_id, survivor_id FROM (
    SELECT id, FIRST_VALUE(id) OVER (
      PARTITION BY \\\"projectId\\\", lower(regexp_replace(email, '^\\s+|\\s+\$', '', 'g'))
      ORDER BY \\\"createdAt\\\" ASC, id ASC) AS survivor_id
    FROM contacts) r WHERE id <> survivor_id)
-- A) 有多少 contact 會被合併掉（>0 就要人工看一遍再部署）
SELECT 'merge_rows' AS check, count(*) FROM map
UNION ALL
-- B) segment membership 重分配會不會撞複合主鍵 → migration 整個 abort
--    （同一組有 3+ contacts、其中 2+ 個 dup 同屬 survivor 不在的 segment）
SELECT 'pk_collisions', count(*) FROM (
  SELECT m.survivor_id, sm.\\\"segmentId\\\" FROM map m
  JOIN segment_memberships sm ON sm.\\\"contactId\\\" = m.dup_id
  WHERE NOT EXISTS (SELECT 1 FROM segment_memberships s2
    WHERE s2.\\\"contactId\\\" = m.survivor_id AND s2.\\\"segmentId\\\" = sm.\\\"segmentId\\\")
  GROUP BY m.survivor_id, sm.\\\"segmentId\\\" HAVING count(*) > 1) c;\""
```

- **兩個都 0** → migration 是 no-op，直接部署
- **`merge_rows` > 0** → 有 contacts 會被合併（survivor = 最舊、退訂狀態取 AND）。先人工確認受影響的人是誰再決定
- **`pk_collisions` > 0** → **不要部署**。upstream migration 的 dedup 只比對 survivor 已有的 membership，漏掉「兩個 dup 同屬同一個 survivor 沒有的 segment」，reassign 時會撞 `(contactId, segmentId)` 主鍵讓 migration abort（交易會 rollback、資料不損，但部署卡住）。先手動清掉重複的 membership 再部署

> 注意：**不要用 `btrim` 版本的檢查**。Postgres `btrim(text)` 預設只去掉半形空格，
> 而 app 端 `ContactService.normalizeEmail` 用 JS `.trim()`（含 tab / NBSP 等全部 Unicode 空白）。
> 用 `btrim` 會漏掉帶 tab/NBSP 的資料，上面的 `regexp_replace` 版才對得上 app 行為。

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
curl -s -o /dev/null -w '%{http_code}\n' https://api.plunk.hanamizuki.tw/templates   # 401 = 正常（endpoint 要 auth，有回 401 表示 API 活著；帶 secret key 則 200）
curl -s -o /dev/null -w '%{http_code}\n' https://plunk.hanamizuki.tw/                # 200
```

寄信類驗證需帶 `from`：mojo project 的寄件 domain 是 `mojoapp.ai`（例 `hello@mojoapp.ai`）；
`mail.mojoapp.ai` 只是退訂 domain，**不是** verified sender，用它會 403。

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

---

## Fork Patches

`deploy/custom` branch 在 upstream release tag 之上疊加的 patch。
分為兩類，**合併 upstream 或發 PR 時務必區分**：

| Patch | 改動檔案 | Upstream? | 說明 |
|-------|----------|:---------:|------|
| Send test email (#331) | EmailService, template API, web UI | ✓ 要發 PR | 從 upstream `v0.11.0` 開乾淨 branch cherry-pick |
| Preview-as-segment (#394) | campaign editor, web UI | ✓ 要發 PR | 從 upstream `v0.11.0` 開乾淨 branch cherry-pick |
| Per-project unsubscribe URL | `constants.ts`, `EmailService.ts`, `SESService.ts` | ✗ 不回 upstream | env var 驅動，詳見 `patches/per-project-unsubscribe-url.md` |
| Template 變數 HTML 逃脫 | `packages/shared/src/template.ts`, `EmailService.ts`, `WorkflowExecutionService.ts`, `EmailEditor.tsx` | ✗ 不回 upstream | body 變數逃脫（subject 不逃）＋ `??` 對空字串生效；upstream 使用者可能依賴變數帶 HTML，故 fork-only |

### 鐵則：分清 upstream vs fork-only

- **✓ 要發 PR** 的 patch：從 `upstream/next`（或最新 release tag）開**乾淨 branch** cherry-pick，不帶任何 fork-only 的改動
- **✗ 不回 upstream** 的 patch：只存在 `deploy/custom`，**絕不** cherry-pick 到 upstream PR branch
- 判斷依據：看上面的表。不確定就問 Hana
- 發 PR 前用 `git log --oneline upstream/next..<pr-branch>` 確認只有該 patch 的 commit，沒有混入 fork-only 的

## Upstream 合併流程

```bash
cd /Users/Hana/Agents/nana/repos/plunk-fork
git fetch upstream
git log --oneline deploy/custom..upstream/next   # 看有多少新 commit
git tag -l --sort=-v:refname | head -3           # 看有沒有新 release tag
```

### 合併步驟

1. 確認要合併的目標（新 release tag 優先，沒有就用 `upstream/next`）
2. `git merge <target>` — 解衝突
3. 衝突重點檢查（fork-only patch 是否存活）：

| 檔案 | 檢查項目 |
|------|---------|
| `apps/api/src/app/constants.ts` | `UNSUBSCRIBE_URI`、`CUSTOM_UNSUBSCRIBE_URLS`、`getUnsubscribeBaseUrl()` 是否還在 |
| `apps/api/src/services/EmailService.ts` | `compile()` 尾端的 URL 替換邏輯是否還在 |
| `apps/api/src/services/SESService.ts` | `List-Unsubscribe` regex 是否仍從 HTML 抽完整 URL |
| `packages/shared/src/template.ts` | `escapeHtml` option 與空字串 default fallback 是否還在（body 呼叫點帶 `{escapeHtml: true}`、subject 不帶） |

4. `yarn build && yarn lint`
5. 測試 → 部署（照上方流程）
