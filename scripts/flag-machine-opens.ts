/**
 * Retroactive machine-open cleanup script.
 *
 * Flags historical Apple MPP opens (UA = "Mozilla/5.0") and recalculates
 * Email.opens / Email.openedAt to exclude them from metrics.
 *
 * Usage:
 *   npx tsx scripts/flag-machine-opens.ts          # dry-run (read-only)
 *   npx tsx scripts/flag-machine-opens.ts --apply   # execute changes
 */
import {Prisma, PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--apply');

/**
 * 重新計算指定 email 的 opens / openedAt / status。
 * 從 flag + recompute 兩個路徑共用，確保邏輯一致。
 *
 * 計算真實 opens 時排除：
 *   1. 已標記 isMachineOpen = true 的 events
 *   2. bare "Mozilla/5.0" UA（尚未標記但屬於 machine open 的 events）
 * 對 userAgent 為 NULL 的 events 視為合法開啟，不排除。
 */
async function recomputeEmailStats(emailIds: string[]) {
  if (emailIds.length === 0) {
    console.log(dryRun ? '=== DRY RUN COMPLETE (no changes made) ===' : '=== DONE ===');
    return;
  }

  console.log(`Recomputing stats for ${emailIds.length} emails`);

  // 單一 GROUP BY 查詢：一次取得每個 emailId 的真實開啟次數和最早開啟時間。
  // 排除機器開啟（已標記的 isMachineOpen 和 bare Mozilla/5.0 UA）。
  // 注意：userAgent 為 NULL 的 events 是合法開啟，用 IS NULL OR != 確保不被排除。
  // Postgres 中 NULL != 'value' 結果是 NULL（非 true），所以必須明確處理 NULL。
  // 使用 btrim() 去除前後空白，與 isMachineOpen() 的 ua.trim() 行為保持一致，
  // 避免歷史 events 中帶有 trailing whitespace 的 UA 被漏判。
  const emailStats = await prisma.$queryRaw<
    Array<{emailId: string; opens: bigint; openedAt: Date | null}>
  >`
    SELECT
      "emailId",
      COUNT(*) as opens,
      MIN("createdAt") as "openedAt"
    FROM events
    WHERE "emailId" IN (${Prisma.join(emailIds)})
      AND name = 'email.open'
      AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
      AND (data->>'userAgent' IS NULL OR btrim(data->>'userAgent') != 'Mozilla/5.0')
    GROUP BY "emailId"
  `;

  // 將查詢結果轉為 Map，方便快速查找。
  // 不在 Map 中的 emailId 代表該 email 已無任何真實開啟事件，opens 歸零。
  const statsMap = new Map(
    emailStats.map(s => [s.emailId, {opens: Number(s.opens), openedAt: s.openedAt}]),
  );

  // 批次取得所有受影響 email 的目前狀態，用於判斷是否需要將 status 從 OPENED 降回 DELIVERED。
  const emails = await prisma.email.findMany({
    where: {id: {in: emailIds}},
    select: {id: true, status: true},
  });
  const statusMap = new Map(emails.map(e => [e.id, e.status]));

  // 列出每封 email 的新數值（dry-run 和 apply 模式都會顯示）
  for (const emailId of emailIds) {
    const stats = statsMap.get(emailId) ?? {opens: 0, openedAt: null};
    console.log(`  Email ${emailId}: opens ${stats.opens}, openedAt ${stats.openedAt?.toISOString() ?? 'NULL'}`);
  }

  if (!dryRun) {
    // 分批執行 update，每批最多 BATCH_SIZE 個，各自包在獨立的 $transaction 中。
    // 避免將所有 update 塞進單一 transaction 導致大量資料時超時。
    const BATCH_SIZE = 500;

    for (let i = 0; i < emailIds.length; i += BATCH_SIZE) {
      const batch = emailIds.slice(i, i + BATCH_SIZE);

      const updates = batch.map(emailId => {
        const stats = statsMap.get(emailId) ?? {opens: 0, openedAt: null};
        const currentStatus = statusMap.get(emailId);

        return prisma.email.update({
          where: {id: emailId},
          data: {
            opens: stats.opens,
            openedAt: stats.openedAt,
            // 只有在目前狀態為 OPENED 且真實開啟次數歸零時，才降回 DELIVERED。
            // 不動 CLICKED、BOUNCED、COMPLAINED 等較高優先級的狀態。
            ...(stats.opens === 0 && currentStatus === 'OPENED' ? {status: 'DELIVERED'} : {}),
          },
        });
      });

      await prisma.$transaction(updates);
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${updates.length} emails`);
    }

    console.log(`Updated ${emailIds.length} emails in batches of ${BATCH_SIZE}`);
  }

  console.log(dryRun ? '=== DRY RUN COMPLETE (no changes made) ===' : '=== DONE ===');
}

async function main() {
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING CHANGES ===');

  // Step 1: Find all machine-open events that haven't been flagged yet.
  // These are open events with the bare "Mozilla/5.0" user-agent string,
  // which is characteristic of Apple Mail Privacy Protection (MPP) proxy fetches.
  const machineOpenEvents = await prisma.$queryRaw<Array<{id: string; emailId: string | null}>>`
    SELECT id, "emailId"
    FROM events
    WHERE name = 'email.open'
      AND btrim(data->>'userAgent') = 'Mozilla/5.0'
      AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
  `;

  console.log(`Found ${machineOpenEvents.length} unflagged machine-open events`);

  // Step 2: Flag unflagged events 並 recompute 受影響 email 的 stats。
  if (machineOpenEvents.length > 0) {
    // Flag events with isMachineOpen = true using jsonb concatenation.
    // This merges the flag into the existing data JSON without overwriting other fields.
    if (!dryRun) {
      const flagged = await prisma.$executeRaw`
        UPDATE events
        SET data = data || '{"isMachineOpen": true}'::jsonb
        WHERE name = 'email.open'
          AND btrim(data->>'userAgent') = 'Mozilla/5.0'
          AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
      `;
      console.log(`Flagged ${flagged} events with isMachineOpen: true`);
    }

    // 批次重新計算受影響 email 的 opens / openedAt。
    const affectedEmailIds = [...new Set(
      machineOpenEvents.filter(e => e.emailId).map(e => e.emailId as string),
    )];
    console.log(`Affected emails: ${affectedEmailIds.length}`);

    await recomputeEmailStats(affectedEmailIds);
  }

  // Step 3: Stale-stats recovery — 每次都執行，不論有無新的 unflagged events。
  // 處理「flag 成功但 recompute 失敗後重跑」的情境，以及上方 Step 2 recompute 後
  // 仍可能遺漏的 email（例如先前 partial failure 殘留的不一致）。
  // 比較 email 目前的 opens 數量與實際真實開啟事件數量，不一致代表 recompute 尚未完成。
  const staleEmails = await prisma.$queryRaw<Array<{emailId: string}>>`
    SELECT DISTINCT e."emailId"
    FROM events e
    JOIN emails em ON em.id = e."emailId"
    WHERE e.name = 'email.open'
      AND e.data->>'isMachineOpen' = 'true'
      AND e."emailId" IS NOT NULL
      AND em.opens > (
        SELECT COUNT(*)
        FROM events e2
        WHERE e2."emailId" = e."emailId"
          AND e2.name = 'email.open'
          AND (e2.data->>'isMachineOpen' IS NULL OR e2.data->>'isMachineOpen' != 'true')
          AND (e2.data->>'userAgent' IS NULL OR btrim(e2.data->>'userAgent') != 'Mozilla/5.0')
      )
  `;

  if (staleEmails.length > 0) {
    console.log(`Found ${staleEmails.length} emails with stale stats — running recovery`);
    await recomputeEmailStats(staleEmails.map(e => e.emailId));
  } else if (machineOpenEvents.length === 0) {
    // 沒有新 unflagged events 且沒有 stale stats，完全沒事做。
    console.log('Nothing to do — all events flagged and email stats are consistent');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
