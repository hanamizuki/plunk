# Per-Project Unsubscribe URL

**分類：✗ Fork-only — 不回 upstream**

## 解決什麼問題

Plunk 原始設計用單一 `DASHBOARD_URI` 建構所有 email 的取消訂閱連結。
這個 patch 讓不同 project 的 email 可以指向不同的退訂網址（例如 `mail.brand-a.com`），
透過環境變數設定，不改 DB schema、不改前端。

## 改了哪些檔案

只改 3 個檔案（刻意不碰 CampaignService、WorkflowExecutionService、Actions、email-processor，
因為那些是 upstream 常改的核心，不碰 = merge 時零衝突）：

### 1. `apps/api/src/app/constants.ts`

新增 env var 解析和 resolver function：

```typescript
export const UNSUBSCRIBE_URI = validateEnv('UNSUBSCRIBE_URI', '');
const CUSTOM_UNSUBSCRIBE_URLS: Record<string, string> = (() => {
  const raw = validateEnv('CUSTOM_UNSUBSCRIBE_URLS', '{}');
  try { return JSON.parse(raw); } catch { return {}; }
})();

export function getUnsubscribeBaseUrl(projectId: string): string {
  const url = CUSTOM_UNSUBSCRIBE_URLS[projectId] || UNSUBSCRIBE_URI || DASHBOARD_URI;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
```

### 2. `apps/api/src/services/EmailService.ts` — `compile()` method

在 `compile()` 的 `return html;` 之前加 post-processing：

```typescript
const customBase = getUnsubscribeBaseUrl(project.id);
if (customBase !== DASHBOARD_URI) {
  html = html.replaceAll(`${DASHBOARD_URI}/unsubscribe/`, `${customBase}/unsubscribe/`);
  html = html.replaceAll(`${DASHBOARD_URI}/subscribe/`, `${customBase}/subscribe/`);
  html = html.replaceAll(`${DASHBOARD_URI}/manage/`, `${customBase}/manage/`);
}
```

### 3. `apps/api/src/services/SESService.ts` — `sendRawEmail()`

改 `List-Unsubscribe` header 的 regex，從 HTML 抽完整 URL 而不是只抽 contact ID 再用 `DASHBOARD_URI` 重建：

```typescript
// Before: /unsubscribe\/([a-f\d-]+)"/  → 重建 URL
// After:  /href="(https?:\/\/[^"]*\/unsubscribe\/[a-f\d-]+)"/  → 直接用 HTML 裡的完整 URL
```

## 環境變數設定

在 EC2 的 `~/mojo-plunk/docker-compose.yml` 的 `app.environment` 加：

```yaml
# 全域 fallback（所有沒有單獨設定的 project 用這個）
UNSUBSCRIBE_URI: "https://mail.mojoapp.ai"

# Per-project 對應（project UUID → base URL）
CUSTOM_UNSUBSCRIBE_URLS: >
  {
    "xxxxxxxx-xxxx-xxxx-xxxx-aaaaaaaaaaaa": "https://mail.brand-a.com",
    "xxxxxxxx-xxxx-xxxx-xxxx-bbbbbbbbbbbb": "https://mail.brand-b.com"
  }
```

Resolution 順序：`CUSTOM_UNSUBSCRIBE_URLS[projectId]` → `UNSUBSCRIBE_URI` → `DASHBOARD_URI`

### 查 project UUID

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "docker exec mojo-plunk-postgres psql -U plunk -d plunk -c \"SELECT id, name FROM projects;\""
```

## Caddy 設定

每個自訂 domain 都需要 Caddy entry 指向同一個 Plunk dashboard：

```
mail.brand-a.com, mail.brand-b.com {
    reverse_proxy localhost:3000
}
```

Caddy 自動處理 Let's Encrypt 憑證。DNS 的 A record 要指向 EC2 IP `13.193.173.27`。

## 新增 project 的 unsubscribe domain

1. 在 Plunk dashboard 建 project → 拿到 UUID
2. 在 `docker-compose.yml` 的 `CUSTOM_UNSUBSCRIBE_URLS` JSON 加一行
3. 在 Caddyfile 加 domain
4. DNS 加 A record
5. `docker compose up -d app`（重啟生效）
6. `sudo caddy reload --config /etc/caddy/Caddyfile`（或 `systemctl reload caddy`）
7. 發測試信驗證連結

## Upstream 合併後驗證

合併 upstream 新版後，跑以下檢查確認 patch 存活：

```bash
# 1. constants.ts 有 getUnsubscribeBaseUrl
grep -n 'getUnsubscribeBaseUrl' apps/api/src/app/constants.ts

# 2. compile() 有 URL 替換
grep -n 'customBase' apps/api/src/services/EmailService.ts

# 3. SESService regex 抽完整 URL（不是只抽 ID）
grep -n 'https.*unsubscribe' apps/api/src/services/SESService.ts

# 4. build
yarn build && yarn lint
```

任一項失敗 = patch 被覆蓋，需手動重新套用（參照上方程式碼片段）。

## 實作 Plan

詳見 `docs/superpowers/plans/2026-06-08-per-project-unsubscribe-url.md`
