import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const branch = 'local/tui-diff-preview';
const kimiBin = resolve(process.env['USERPROFILE'] || process.env['HOME'], '.kimi-code', 'bin', 'kimi.exe');

function run(cmd, opts = {}) {
  console.log(`\n==> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function checkBranch() {
  const current = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf-8' }).trim();
  if (current !== branch) {
    console.error(`Error: must be on branch "${branch}" (current: "${current}")`);
    process.exit(1);
  }
}

console.log(`==> Rebuild local kimi (branch: ${branch})`);

// 1. Ensure we're on the right branch
checkBranch();

// 2. Fetch latest upstream
run('git fetch origin main');

// 3. Rebase our commit onto latest main
console.log('==> Rebasing onto origin/main...');
try {
  run(`git rebase origin/main`);
} catch {
  console.error('\n!!! Rebase failed. Fix conflicts manually, then rerun this script.');
  console.error('    After fixing: git rebase --continue');
  process.exit(1);
}

// 4. Install dependencies
run('pnpm install');

// 5. Build packages
run('pnpm -r --filter "./packages/*" run build');

// 6. Build native SEA binary
run('pnpm -C apps/kimi-code run build:native:sea');

// 7. Replace installed binary
const built = resolve(root, 'apps/kimi-code/dist-native/bin/win32-x64/kimi.exe');
if (!existsSync(built)) {
  console.error(`Error: built binary not found at ${built}`);
  process.exit(1);
}
copyFileSync(built, kimiBin);
console.log(`\n==> ✅ Done. Installed to ${kimiBin}`);
console.log(`    Version output:`);
try {
  execSync(`"${kimiBin}" --version`, { stdio: 'inherit' });
} catch {}