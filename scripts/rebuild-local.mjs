import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const branch = 'dev/tui-diff-preview';
const upstreamRemote = 'origin';
const forkRemote = 'jochen';
const forkBranch = branch;
const kimiBin = resolve(process.env['USERPROFILE'] || process.env['HOME'], '.kimi-code', 'bin', 'kimi.exe');

function run(cmd, opts = {}) {
  console.log(`\n==> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function shellOut(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function hasUncommittedChanges() {
  try {
    const status = shellOut('git status --porcelain');
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function checkBranch() {
  const current = shellOut('git rev-parse --abbrev-ref HEAD').trim();
  if (current !== branch) {
    console.error(`Error: must be on branch "${branch}" (current: "${current}")`);
    console.error('       Switch with: git switch ' + branch);
    process.exit(1);
  }
}

console.log(`==> Rebuild + sync kimi (branch: ${branch})`);

// 1. Ensure we're on the right branch
checkBranch();

// 2. If the script itself is mid-edit (working tree dirty), stash so rebase can run.
let stashed = false;
let stashRef = '';
if (hasUncommittedChanges()) {
  console.log('\n==> Stashing uncommitted changes so rebase can proceed...');
  run('git stash push -u -m "rebuild-local: auto-stash"');
  stashed = true;
  stashRef = shellOut('git rev-parse --verify --quiet refs/stash@{0} >/dev/null 2>&1 && git rev-parse stash@{0} || echo ""').trim();
}

// 3. Fetch latest upstream
run(`git fetch ${upstreamRemote} main`);

// 4. Rebase our patches onto latest upstream main
console.log(`\n==> Rebasing onto ${upstreamRemote}/main...`);
let needsRebase = false;
try {
  shellOut(`git merge-base --is-ancestor ${upstreamRemote}/main HEAD`, { stdio: 'pipe' });
} catch {
  needsRebase = true;
}
if (needsRebase) {
  try {
    run(`git rebase ${upstreamRemote}/main`);
  } catch {
    console.error('\n!!! Rebase failed. Resolve conflicts, then:');
    console.error('      git rebase --continue   (when ready to retry)');
    console.error('      git rebase --abort     (to discard and start over)');
    process.exit(1);
  }
} else {
  console.log('    (already up to date with upstream main — skipping rebase)');
}

// 5. Restore stashed changes (if any). Safe to do after rebase: rebase only
// touches commits, and stash apply conflicts are visible to the user.
if (stashed) {
  console.log('\n==> Restoring stashed changes...');
  try {
    run('git stash pop');
  } catch {
    console.error('!!! Stash pop hit conflicts. Resolve them, then rerun the script.');
    process.exit(1);
  }
}

// 6. Install dependencies
run('pnpm install');

// 7. Build packages
run('pnpm -r --filter "./packages/*" run build');

// 8. Build native SEA binary
run('pnpm -C apps/kimi-code run build:native:sea');

// 9. Replace installed binary
const built = resolve(root, 'apps/kimi-code/dist-native/bin/win32-x64/kimi.exe');
if (!existsSync(built)) {
  console.error(`Error: built binary not found at ${built}`);
  process.exit(1);
}
copyFileSync(built, kimiBin);
console.log(`\n==> ✅ Installed to ${kimiBin}`);

// 10. Push the rebased branch to the fork so the fork mirrors
//     "upstream main + our patches". This is a sync, so use push with
//     --force-with-lease: rebase rewrites our local commits so the fast-
//     forward assumption doesn't hold, but the remote state is updated
//     only if no one else moved HEAD on the fork.
console.log(`\n==> Syncing to ${forkRemote}/${forkBranch}...`);
try {
  run(`git push ${forkRemote} ${branch}:${forkBranch} --force-with-lease`);
} catch (err) {
  console.error(`\n!!! Push failed. The fork's ${forkBranch} branch may have moved (e.g. another machine ran this script).`);
  console.error('    Inspect the remote ref, then either:');
  console.error('      git fetch ' + forkRemote);
  console.error('      # then resolve locally and rerun this script, or');
  console.error('      git push ' + forkRemote + ' ' + branch + ':' + forkBranch + ' --force-with-lease');
  process.exit(1);
}

console.log(`    Version output:`);
try {
  execSync(`"${kimiBin}" --version`, { stdio: 'inherit' });
} catch {}
