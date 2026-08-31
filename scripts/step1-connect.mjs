// Step 1: connect device A to Drive and snapshot the existing appDataFolder
// contents as a restore point before any sync writes to it.
import { writeFileSync } from 'node:fs';
import { openDevice, connectDrive, driveState, listDriveFiles, downloadDriveFile } from './drive-lib.mjs';

const dir = process.argv[2];
const { ctx, page } = await openDevice(dir, { headless: process.env.HEADFUL !== '1' });

console.log('== device A loaded ==');
console.log('  state before:', JSON.stringify(await driveState(page)));

const ok = await connectDrive(ctx, page, 'A');
if (!ok) {
  await page.screenshot({ path: '/tmp/synctest-A-failed.png' }).catch(() => {});
  console.log('CONNECT FAILED');
  await ctx.close();
  process.exit(1);
}

const files = await listDriveFiles(page);
console.log('== appDataFolder BEFORE any sync ==');
console.log(JSON.stringify(files, null, 1));

if (files.files) {
  for (const f of files.files) {
    const body = await downloadDriveFile(page, f.id);
    const out = `/tmp/drive-snapshot-${f.name}`;
    writeFileSync(out, body);
    console.log(`  saved ${out} (${body.length} bytes)`);
  }
}
await ctx.close();
console.log('STEP1 OK');
