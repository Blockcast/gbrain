/**
 * End-to-end durability hook + helper (v0.42.44): the generated bash actually
 * pushes. Real git, local bare remote. Validates the D13 guarantee (helper),
 * the D9 self-contained local hook, and the D7 "one push-retry template" claim
 * (the hook works even with the committed helper deleted).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}
async function waitForOrigin(bare: string, expectSha: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (originHead(bare) === expectSha) return true; } catch { /* */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// Terminal lines of the hook's brain_push — one is appended on every exit path,
// after all of its git subprocesses have exited.
const HOOK_SETTLED = /\[push\] (ok|ok-after-rebase|LOCAL-ONLY|lock-timeout|detached)/;
/**
 * Barrier on the background post-commit push having FINISHED.
 *
 * `waitForOrigin` returns as soon as the ref lands on the remote, which is not the
 * same event: the hook can still be inside `git pull --rebase` holding
 * `.git/index.lock`, and the next `git add` then dies with
 * "Unable to create '.git/index.lock': File exists".
 *
 * hardenBrainRepo() commits the scaffolding (firing the hook -> background push)
 * AND pushes synchronously itself. The two race; the background one loses, rebases,
 * and takes index.lock a few ms after hardenBrainRepo has already returned — so
 * beforeEach must drain it before any test touches the index.
 */
async function waitForHookSettled(ms = 8000): Promise<boolean> {
  const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(log) && HOOK_SETTLED.test(readFileSync(log, 'utf-8'))) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

let root: string, work: string, bare: string;
let oldHome: string | undefined, oldGbrainHome: string | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bdh-'));
  oldHome = process.env.HOME; oldGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  process.env.GBRAIN_HOME = join(process.env.HOME, '.gbrain');
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t'); git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  await hardenBrainRepo({ repoPath: work, sourceId: 'wiki', pat: 'ghp_x', installCron: false });
  // Drain the background push the scaffolding commit just spawned, or it races the
  // first `git add` of whichever test runs next.
  await waitForHookSettled();
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('brain-commit-push.sh (D13 guarantee)', () => {
  test('add → commit → push lands on origin', () => {
    mkdirSync(join(work, 'people'), { recursive: true });
    writeFileSync(join(work, 'people', 'alice.md'), '# alice\n');
    // helper requires explicit path; stages people/alice.md
    execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'add alice', 'people/alice.md'], {
      cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
    // origin actually has the file
    const verify = mkdtempSync(join(root, 'verify-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, verify], { stdio: 'ignore' });
    expect(existsSync(join(verify, 'people', 'alice.md'))).toBe(true);
  });

  test('refuses success when the push cannot land (exit non-zero)', () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    writeFileSync(join(work, 'x.md'), 'x\n');
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg', 'x.md'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).not.toBe(0); // committed but push failed → loud failure
  });

  test('refuses a blind add (no explicit path)', () => {
    let code = 0;
    try {
      execFileSync('bash', [join(work, 'scripts', 'brain-commit-push.sh'), 'msg'], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
    } catch (e: any) { code = e.status ?? 1; }
    expect(code).toBe(2);
  });
});

describe('post-commit hook (D9 local, D7 self-contained)', () => {
  test('a direct commit auto-pushes in the background', async () => {
    writeFileSync(join(work, 'note.md'), 'note\n');
    git(work, 'add', 'note.md'); git(work, 'commit', '-qm', 'note'); // fires .git/hooks/post-commit
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  });

  test('the hook works even with the committed helper deleted (self-contained)', async () => {
    rmSync(join(work, 'scripts', 'brain-commit-push.sh'));
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'remove helper');
    const head = git(work, 'rev-parse', 'HEAD');
    expect(await waitForOrigin(bare, head)).toBe(true);
  });

  test('logs a clear LOCAL-ONLY line when origin is unreachable', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone2.git'));
    writeFileSync(join(work, 'orphan.md'), 'o\n');
    git(work, 'add', 'orphan.md'); git(work, 'commit', '-qm', 'orphan');
    const log = join(process.env.GBRAIN_HOME!, 'brain-push.log');
    const deadline = Date.now() + 8000;
    let found = false;
    while (Date.now() < deadline) {
      if (existsSync(log) && readFileSync(log, 'utf-8').includes('NEEDS ATTENTION')) { found = true; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    expect(found).toBe(true);
  });
});
