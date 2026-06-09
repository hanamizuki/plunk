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

新增 env var 解析和 resolver function（`UNSUBSCRIBE_URI` 不 export，只在內部使用）：

```typescript
const UNSUBSCRIBE_URI = validateEnv('UNSUBSCRIBE_URI', '');
const CUSTOM_UNSUBSCRIBE_URLS: Record<string, string> = (() => {
  const raw = validateEnv('CUSTOM_UNSUBSCRIBE_URLS', '{}');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[PLUNK] CUSTOM_UNSUBSCRIBE_URLS must be a JSON object, ignoring');
      return {};
    }
    const filtered: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string') {
        filtered[key] = val;
      } else {
        console.warn(`[PLUNK] CUSTOM_UNSUBSCRIBE_URLS["${key}"] is not a string, ignoring`);
      }
    }
    return filtered;
  } catch (e) {
    if (raw !== '{}') {
      console.warn('[PLUNK] CUSTOM_UNSUBSCRIBE_URLS is not valid JSON, ignoring:', (e as Error).message);
    }
    return {};
  }
})();

export function getUnsubscribeBaseUrl(projectId: string): string {
  const url = CUSTOM_UNSUBSCRIBE_URLS[projectId] || UNSUBSCRIBE_URI || DASHBOARD_URI;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
```

### 2. `apps/api/src/services/EmailService.ts` — `compile()` method

在 `compile()` 的 `return html;` 之前加 post-processing。
同時 normalize `DASHBOARD_URI` 的 trailing slash，並處理 raw 形式（double-slash）：

```typescript
const dashboardBase = DASHBOARD_URI.endsWith('/') ? DASHBOARD_URI.slice(0, -1) : DASHBOARD_URI;
const customBase = getUnsubscribeBaseUrl(project.id);
if (customBase !== dashboardBase) {
  for (const path of ['/unsubscribe/', '/subscribe/', '/manage/']) {
    html = html.replaceAll(`${dashboardBase}${path}`, `${customBase}${path}`);
    if (DASHBOARD_URI !== dashboardBase) {
      html = html.replaceAll(`${DASHBOARD_URI}${path}`, `${customBase}${path}`);
    }
  }
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
# Per-project 對應（project UUID → base URL）
CUSTOM_UNSUBSCRIBE_URLS: '{ "16e32c0f-...": "https://mail.ethtaipei.org", "7d28d341-...": "https://mail.hanamizuki.tw", "294d807b-...": "https://mail.mojoapp.ai" }'
```

Resolution 順序：`CUSTOM_UNSUBSCRIBE_URLS[projectId]` → `UNSUBSCRIBE_URI` → `DASHBOARD_URI`

### 查 project UUID

```bash
ssh -i ~/.secrets/aws-ec2/hana-prod.pem ubuntu@13.193.173.27 \
  "docker exec mojo-plunk-postgres psql -U plunk -d plunk -c \"SELECT id, name FROM projects;\""
```

## DASHBOARD_DOMAIN（必要）

Container 內部有 nginx 做 hostname-based 路由。不認識的 hostname 會被導到 API server（回 404），
不會到 web app。**必須把自訂 domain 加到 `DASHBOARD_DOMAIN`**（空格分隔），包含 dashboard 主域名：

```yaml
DASHBOARD_DOMAIN: "plunk.hanamizuki.tw mail.mojoapp.ai mail.ethtaipei.org mail.hanamizuki.tw"
```

不加這個，退訂頁面會回 `{"error":"Unknown route"}` 404。

## DASHBOARD_URI 與 dashboard 主域名

`DASHBOARD_URI` 決定兩件事：
1. **前端 JS bundle 裡的 API URL**（container 啟動時 `replace-urls-optimized.sh` 會替換）
2. **Express CORS allowedOrigins**（只允許 `DASHBOARD_URI` 的 origin）
3. **email 裡的預設退訂連結 base URL**（被 `compile()` 的 replaceAll 替換前的原始值）

目前設為 `https://plunk.hanamizuki.tw`（通用後台），不是任何特定 project 的 domain。

## Caddy CORS 設定（關鍵）

Express API 的 CORS middleware 只允許 `DASHBOARD_URI` origin。其他退訂 domain 從瀏覽器
呼叫 `api.mail.mojoapp.ai` 會被 Express CORS reject。

解法：**Caddy 統一管 CORS** — strip Express 的 CORS header，加上自己的（接受所有 origin）：

```
api.mail.mojoapp.ai {
    @preflight {
        method OPTIONS
    }

    handle @preflight {
        header Access-Control-Allow-Origin "{http.request.header.Origin}"
        header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization, X-Project-Id"
        header Access-Control-Allow-Credentials "true"
        respond 204
    }

    handle {
        reverse_proxy mojo-plunk-app:8080 {
            header_down -Access-Control-Allow-Origin
            header_down -Access-Control-Allow-Credentials
            header_down -Access-Control-Allow-Methods
            header_down -Access-Control-Allow-Headers
        }
        header Access-Control-Allow-Origin "{http.request.header.Origin}"
        header Access-Control-Allow-Credentials "true"
    }
}
```

### 重要注意事項

- **PATCH 必須在 Allow-Methods 裡** — dashboard 編輯 contact 用 PATCH，漏了會 Failed to fetch
- **`header_down -`** 放在 `reverse_proxy` block 裡 — strip Express 回傳的 CORS header，避免 duplicate
- **`header` 設在 `handle` block 裡** — 而不是外層，避免跟 preflight handler 的 header 互相干擾
- **改完 Caddyfile 後要 `docker restart caddy`** — `caddy reload` 不一定會重讀 bind mount 的檔案

## Caddy 退訂 domain entries

每個自訂 domain 都需要 Caddy entry 指向 Plunk dashboard（web app port 80）：

```
mail.ethtaipei.org {
    reverse_proxy mojo-plunk-app:80
}

mail.hanamizuki.tw {
    reverse_proxy mojo-plunk-app:80
}
```

Caddy 自動處理 Let's Encrypt 憑證。DNS 的 A record 要指向 EC2 IP `13.193.173.27`。

Dashboard 主域名和可以登入的域名放在一起：

```
plunk.hanamizuki.tw, mail.mojoapp.ai {
    reverse_proxy mojo-plunk-app:80
}
```

**注意**：只有 `plunk.hanamizuki.tw` 能正常登入 dashboard（因為 `DASHBOARD_URI` 指向它，
cookie 和 API 呼叫都走同 origin）。其他退訂 domain 可以顯示退訂頁面（public endpoint），
但無法登入。

## 當前 production 設定

```yaml
# docker-compose.yml (app.environment)
DASHBOARD_URI: "https://plunk.hanamizuki.tw"
DASHBOARD_DOMAIN: "plunk.hanamizuki.tw mail.mojoapp.ai mail.ethtaipei.org mail.hanamizuki.tw"
CUSTOM_UNSUBSCRIBE_URLS: '{ "16e32c0f-b9af-4f72-bfe9-1e3988fc36b6": "https://mail.ethtaipei.org", "7d28d341-0438-4ef7-8ffb-f40304e3bcda": "https://mail.hanamizuki.tw", "294d807b-747e-49ba-aeba-7d2cd7a66275": "https://mail.mojoapp.ai", "04bc2f1b-3c14-444d-9f0b-c5cbc69db8b8": "https://mail.mojoapp.ai" }'
```

| Domain | 用途 | 可登入？ |
|--------|------|:--------:|
| `plunk.hanamizuki.tw` | Dashboard 後台 | ✓ |
| `mail.mojoapp.ai` | mojo / mojo (en) 退訂 | ✗ |
| `mail.ethtaipei.org` | ETHTaipei 退訂 | ✗ |
| `mail.hanamizuki.tw` | Hana 退訂 | ✗ |

## 新增 project 的 unsubscribe domain

1. 在 Plunk dashboard 建 project → 拿到 UUID
2. 在 `docker-compose.yml` 的 `CUSTOM_UNSUBSCRIBE_URLS` JSON 加一筆
3. 在 `DASHBOARD_DOMAIN` 加上新 domain（空格分隔）
4. 在 `~/caddy/Caddyfile` 加 domain entry（`reverse_proxy mojo-plunk-app:80`）
5. DNS 加 A record → `13.193.173.27`
6. `cd ~/mojo-plunk && docker compose up -d app`（重啟 Plunk）
7. `docker restart caddy`（**不是** `caddy reload`，bind mount 需要 restart）
8. 發測試信驗證退訂連結 + List-Unsubscribe header

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
