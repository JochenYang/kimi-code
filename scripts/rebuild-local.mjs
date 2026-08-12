import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const branch = 'dev';
const upstreamRemote = 'upstream';
const forkRemote = 'origin';
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
  const status = shellOut('git status --porcelain');
  return status.trim().length > 0;
}

function checkBranch() {
  const current = shellOut('git rev-parse --abbrev-ref HEAD').trim();
  if (current !== branch) {
    throw new Error(`must be on branch "${branch}" (current: "${current}")`);
  }
}

function stashUncommittedChanges() {
  const marker = `rebuild-local: auto-stash ${process.pid}-${Date.now()}`;
  console.log('\n==> Stashing uncommitted changes so rebase can proceed...');
  run(`git stash push -u -m "${marker}"`);

  // Resolve our unique marker to a commit instead of trusting stash@{0};
  // another process may add a newer stash before this lookup completes.
  const entries = shellOut('git stash list --format="%H%x09%gs"').trim();
  for (const entry of entries.split(/\r?\n/)) {
    const [commit, subject] = entry.split('\t', 2);
    if (subject?.endsWith(marker)) return commit;
  }
  throw new Error(`created automatic stash could not be located; look for "${marker}" in git stash list`);
}

function applyStash(stashCommit) {
  console.log(`\n==> Restoring stashed changes (${stashCommit})...`);
  run(`git stash apply ${stashCommit}`);

  // If apply conflicts, the stash remains available for recovery.
}

function findStashSelector(stashCommit) {
  const entries = shellOut('git stash list --format="%gd%x09%H"').trim();
  if (!entries) return '';

  for (const entry of entries.split(/\r?\n/)) {
    const [selector, commit] = entry.split('\t');
    if (commit === stashCommit) return selector;
  }
  return '';
}

function dropStash(stashCommit) {
  const selector = findStashSelector(stashCommit);
  if (!selector) {
    throw new Error(`automatic stash ${stashCommit} is no longer present`);
  }
  run(`git stash drop "${selector}"`);
}

function printStashRecovery(stashCommit, { rebaseFailed, stashApplied }) {
  console.error('\n!!! The automatic stash was not fully cleaned up.');
  console.error(`    Automatic stash commit: ${stashCommit}`);
  if (rebaseFailed) {
    console.error('    First finish the rebase or abort it:');
    console.error('      git rebase --continue');
    console.error('      git rebase --abort');
  }
  if (stashApplied) {
    console.error('    The changes were applied. If verified, remove the matching stash:');
  } else {
    console.error('    The changes are still preserved in the stash. Restore them with:');
    console.error(`      git stash apply ${stashCommit}`);
    console.error('    After verifying the restored files, remove the matching stash:');
  }
  console.error('      git stash list --format="%gd %H %gs"');
  console.error('      git stash drop <matching-stash-selector>');
}

function main() {
  console.log(`==> Rebuild + sync kimi (branch: ${branch})`);

  let stashCommit = '';
  let stashApplied = false;
  let stashDropped = false;
  let rebaseFailed = false;

  try {
    // 1. Ensure we're on the right branch.
    checkBranch();

    // 2. Temporarily remove local changes before fetch/rebase. They are
    // restored before any install/build/push step.
    if (hasUncommittedChanges()) {
      stashCommit = stashUncommittedChanges();
    }

    // 3. Fetch latest upstream.
    run(`git fetch ${upstreamRemote} main`);

    // 4. Rebase our patches onto latest upstream main.
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
        rebaseFailed = true;
        console.error('\n!!! Rebase failed. Resolve conflicts, then:');
        console.error('      git rebase --continue   (when ready to retry)');
        console.error('      git rebase --abort     (to discard and start over)');
        throw new Error('rebase failed');
      }
    } else {
      console.log('    (already up to date with upstream main — skipping rebase)');
    }

    // 5. Restore the exact stash created above. Rebase must succeed before
    // applying local changes; conflicts leave the stash intact.
    if (stashCommit) {
      applyStash(stashCommit);
      stashApplied = true;
      dropStash(stashCommit);
      stashDropped = true;
    }

    // 6. Install dependencies.
    run('pnpm install');

    // 7. Build packages.
    run('pnpm -r --filter "./packages/*" run build');

    // 8. Build native SEA binary.
    run('pnpm -C apps/kimi-code run build:native:sea');

    // 9. Replace installed binary.
    const built = resolve(root, 'apps/kimi-code/dist-native/bin/win32-x64/kimi.exe');
    if (!existsSync(built)) {
      throw new Error(`built binary not found at ${built}`);
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
    } catch {
      console.error(`\n!!! Push failed. The fork's ${forkBranch} branch may have moved (e.g. another machine ran this script).`);
      console.error('    Inspect the remote ref, then either:');
      console.error('      git fetch ' + forkRemote);
      console.error('      # then resolve locally and rerun the script, or');
      console.error('      git push ' + forkRemote + ' ' + branch + ':' + forkBranch + ' --force-with-lease');
      throw new Error('push failed');
    }

    console.log('    Version output:');
    try {
      execSync(`"${kimiBin}" --version`, { stdio: 'inherit' });
    } catch {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n!!! Rebuild failed: ${message}`);
    if (stashCommit && !stashDropped) {
      printStashRecovery(stashCommit, { rebaseFailed, stashApplied });
    }
    process.exitCode = 1;
  }
}

main();
