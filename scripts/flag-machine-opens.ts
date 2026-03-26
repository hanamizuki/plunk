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

async function main() {
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING CHANGES ===');

  // Step 1: Find all machine-open events that haven't been flagged yet.
  // These are open events with the bare "Mozilla/5.0" user-agent string,
  // which is characteristic of Apple Mail Privacy Protection (MPP) proxy fetches.
  const machineOpenEvents = await prisma.$queryRaw<Array<{id: string; emailId: string | null}>>`
    SELECT id, "emailId"
    FROM events
    WHERE name = 'email.open'
      AND data->>'userAgent' = 'Mozilla/5.0'
      AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
  `;

  console.log(`Found ${machineOpenEvents.length} machine-open events to flag`);

  if (machineOpenEvents.length === 0) {
    console.log('Nothing to do');
    return;
  }

  // Step 2: Flag events with isMachineOpen = true using jsonb concatenation.
  // This merges the flag into the existing data JSON without overwriting other fields.
  if (!dryRun) {
    const flagged = await prisma.$executeRaw`
      UPDATE events
      SET data = data || '{"isMachineOpen": true}'::jsonb
      WHERE name = 'email.open'
        AND data->>'userAgent' = 'Mozilla/5.0'
        AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
    `;
    console.log(`Flagged ${flagged} events with isMachineOpen: true`);
  }

  // Step 3: 批次重新計算 Email.opens 和 Email.openedAt。
  // 用 GROUP BY 一次算出所有受影響 email 的真實 opens 數量與最早開啟時間，
  // 避免對每個 emailId 逐一查詢造成 N+1 問題。
  const affectedEmailIds = [...new Set(
    machineOpenEvents.filter(e => e.emailId).map(e => e.emailId as string),
  )];
  console.log(`Affected emails: ${affectedEmailIds.length}`);

  if (affectedEmailIds.length === 0) {
    console.log(dryRun ? '=== DRY RUN COMPLETE (no changes made) ===' : '=== DONE ===');
    return;
  }

  // 單一 GROUP BY 查詢：一次取得每個 emailId 的真實開啟次數和最早開啟時間。
  // 排除機器開啟（已標記的 isMachineOpen 和 bare Mozilla/5.0 UA）。
  const emailStats = await prisma.$queryRaw<
    Array<{emailId: string; opens: bigint; openedAt: Date | null}>
  >`
    SELECT
      "emailId",
      COUNT(*) as opens,
      MIN("createdAt") as "openedAt"
    FROM events
    WHERE "emailId" IN (${Prisma.join(affectedEmailIds)})
      AND name = 'email.open'
      AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
      AND data->>'userAgent' != 'Mozilla/5.0'
    GROUP BY "emailId"
  `;

  // 將查詢結果轉為 Map，方便快速查找。
  // 不在 Map 中的 emailId 代表該 email 已無任何真實開啟事件，opens 歸零。
  const statsMap = new Map(
    emailStats.map(s => [s.emailId, {opens: Number(s.opens), openedAt: s.openedAt}]),
  );

  // 批次取得所有受影響 email 的目前狀態，用於判斷是否需要將 status 從 OPENED 降回 DELIVERED。
  const emails = await prisma.email.findMany({
    where: {id: {in: affectedEmailIds}},
    select: {id: true, status: true},
  });
  const statusMap = new Map(emails.map(e => [e.id, e.status]));

  // 列出每封 email 的新數值（dry-run 和 apply 模式都會顯示）
  for (const emailId of affectedEmailIds) {
    const stats = statsMap.get(emailId) ?? {opens: 0, openedAt: null};
    console.log(`  Email ${emailId}: opens ${stats.opens}, openedAt ${stats.openedAt?.toISOString() ?? 'NULL'}`);
  }

  if (!dryRun) {
    // 用 $transaction 批次執行所有 update，確保原子性且大幅減少 DB round-trip。
    const updates = affectedEmailIds.map(emailId => {
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
    console.log(`Updated ${updates.length} emails in a single transaction`);
  }

  console.log(dryRun ? '=== DRY RUN COMPLETE (no changes made) ===' : '=== DONE ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
