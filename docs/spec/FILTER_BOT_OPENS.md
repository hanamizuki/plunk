# Filter Bot/Proxy Opens from Email Tracking

## 問題

SES Open 事件是透過 tracking pixel（1x1 透明圖片）觸發的。Gmail 伺服器收到信後會在 3-4 秒內自動預載所有圖片，導致 tracking pixel 被載入，SES 回報一個假的 Open 事件。

實測數據（March 2026 Newsletter - Android campaign）：
- 806 封寄出，330 個 open（40.9%）
- 334/343 個 open 來自 Gmail
- 全部在寄出後 3.3~3.8 秒觸發，不可能是真人

## SES Open 事件結構

SES 的 SNS notification 中，Open 事件的 `body` 長這樣：

```json
{
  "eventType": "Open",
  "mail": { "messageId": "..." },
  "open": {
    "timestamp": "2026-03-25T14:09:48.750Z",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    "ipAddress": "66.249.92.1"
  }
}
```

目前 `body.open.userAgent` 和 `body.open.ipAddress` 完全沒被使用。

## 需要改的檔案

`apps/api/src/controllers/Webhooks.ts` — `case 'Open':` 區塊（約 L290）

## 需求

在處理 Open 事件時，用 `body.open.userAgent` 判斷是否為 bot/proxy，如果是則跳過，不更新 email 狀態和 open count。

### 判斷邏輯

已知的 bot/proxy userAgent pattern（用 case-insensitive 比對）：

- `GoogleImageProxy` — Gmail 圖片預載
- `YahooMailProxy` — Yahoo Mail 圖片預載
- `Outlook-iOS-Android` 搭配 `Microsoft Office` — Outlook 預載
- 空字串或 undefined — 沒有 userAgent 的 open 也視為可疑，但先放行，只 log warning

### 行為

1. **是 bot** → log `[WEBHOOK] Bot open filtered: {userAgent} for {email}` → 回 200，不更新任何東西
2. **不是 bot** → 維持現有邏輯不變

### 額外：把 userAgent 存進 event data

對於非 bot 的 open/click，把 `body.open.userAgent` 存進 eventData，方便未來分析。Bot 事件因為 early return 不會產生 eventData。

```typescript
eventData = {
  ...baseEventData,
  openedAt: ...,
  opens: ...,
  isFirstOpen: ...,
  userAgent: body.open?.userAgent || null,  // 新增
};
```

### Click 事件也要一併處理

`body.click` 也有 `userAgent`，同樣的 bot pattern 過濾也要套用到 `case 'Click':` 區塊。

## 不需要改的

- DB schema 不用改（不加欄位）
- Campaign stats 計算邏輯不用改（它是基於 email 的 openedAt 算的，bot open 不寫入就自然不會算進去）
- Dashboard UI 不用改

## 測試驗證

改完後可以用 curl 模擬 SNS notification 來測：

```bash
curl -X POST "http://localhost:3000/webhooks/sns" \
  -H "Content-Type: application/json" \
  -d '{
    "Type": "Notification",
    "Message": "{\"eventType\":\"Open\",\"mail\":{\"messageId\":\"<existing-message-id>\"},\"open\":{\"timestamp\":\"2026-03-25T14:09:48Z\",\"userAgent\":\"GoogleImageProxy\",\"ipAddress\":\"66.249.92.1\"}}"
  }'
```

預期：回 200，但 email status 不更新、opens 不 +1。

## Machine Open Filtering

### Bot vs Machine Open 區別

| 類型 | 範例 | 處理方式 |
|------|------|----------|
| **Bot opens** | YahooMailProxy, Barracuda Sentinel, Outlook preloading | 完全拒絕，不記錄 Event，不更新 Email |
| **Machine opens** | Apple Mail Privacy Protection (MPP) | 記錄 Event（加 `isMachineOpen: true`），但不更新 Email stats、不觸發 Workflow |

### Apple MPP 偵測邏輯

Apple Mail Privacy Protection（iOS 15+ / macOS 12+）在 email 送達時自動預載所有 tracking pixel。其 UserAgent 為裸字串 `Mozilla/5.0`，不含 OS 或瀏覽器資訊。真實瀏覽器的 UA 在 `Mozilla/5.0` 後一定會有括號包裹的平台資訊。

偵測方式：`ua.trim() === 'Mozilla/5.0'`（exact match）。

### 資料流

1. SES webhook 收到 Open event
2. `filterBotEvent()` 檢查 — bot 則直接拒絕
3. `isMachineOpen()` 檢查 — machine open 則：
   - 透過 `prisma.event.create()` 記錄 Event（含 `isMachineOpen: true`）
   - 不呼叫 `EventService.trackEvent()`（避免觸發 workflow）
   - 不更新 `Email.opens`、`Email.openedAt`、`Email.status`
   - 回傳 `{success: true, filtered: 'machine_open'}`
4. 正常 open → 更新 Email stats + 觸發 workflow

### 回溯清理

使用 `scripts/flag-machine-opens.ts`：
- Dry-run：`npx tsx scripts/flag-machine-opens.ts`
- 執行：`npx tsx scripts/flag-machine-opens.ts --apply`
- 冪等設計，可安全重複執行
