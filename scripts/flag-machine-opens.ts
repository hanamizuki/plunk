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
import {PrismaClient} from '@prisma/client';

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

  // Step 3: Recalculate Email.opens and Email.openedAt for every email
  // that had at least one machine-open event. This corrects the denormalized
  // counters by counting only genuine (non-machine) open events.
  const affectedEmailIds = [...new Set(
    machineOpenEvents.filter(e => e.emailId).map(e => e.emailId as string),
  )];
  console.log(`Affected emails: ${affectedEmailIds.length}`);

  for (const emailId of affectedEmailIds) {
    // Count real opens — exclude both already-flagged and about-to-be-flagged events.
    // The dual condition handles both dry-run (where isMachineOpen hasn't been set yet)
    // and re-runs (where it has).
    const [{count: realOpens}] = await prisma.$queryRaw<Array<{count: bigint}>>`
      SELECT COUNT(*) as count
      FROM events
      WHERE "emailId" = ${emailId}
        AND name = 'email.open'
        AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
        AND data->>'userAgent' != 'Mozilla/5.0'
    `;

    const opens = Number(realOpens);

    // Find the earliest real open timestamp to set as openedAt
    const firstRealOpen = await prisma.$queryRaw<Array<{createdAt: Date | null}>>`
      SELECT MIN("createdAt") as "createdAt"
      FROM events
      WHERE "emailId" = ${emailId}
        AND name = 'email.open'
        AND (data->>'isMachineOpen' IS NULL OR data->>'isMachineOpen' != 'true')
        AND data->>'userAgent' != 'Mozilla/5.0'
    `;

    const openedAt = firstRealOpen[0]?.createdAt ?? null;

    console.log(`  Email ${emailId}: opens ${opens}, openedAt ${openedAt?.toISOString() ?? 'NULL'}`);

    if (!dryRun) {
      // Only revert status to DELIVERED if currently OPENED —
      // don't downgrade CLICKED, BOUNCED, or COMPLAINED
      const email = await prisma.email.findUnique({
        where: {id: emailId},
        select: {status: true},
      });

      await prisma.email.update({
        where: {id: emailId},
        data: {
          opens,
          openedAt,
          ...(opens === 0 && email?.status === 'OPENED' ? {status: 'DELIVERED'} : {}),
        },
      });
    }
  }

  console.log(dryRun ? '=== DRY RUN COMPLETE (no changes made) ===' : '=== DONE ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
