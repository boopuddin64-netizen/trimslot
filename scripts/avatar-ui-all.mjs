/* Runs both profile-photo browser tests one after the other against BASE (npm run avatar-ui boots a throw-away server on a free port and sets BASE). */
import { spawnSync } from 'child_process';
let code = 0;
for (const s of ['scripts/avatar-crop-ui.mjs', 'scripts/avatar-photos-ui.mjs']) {
  const r = spawnSync(process.execPath, [s], { stdio: 'inherit', env: process.env });
  if (r.status) code = r.status;
}
process.exit(code);
