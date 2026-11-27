import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

// Keep the local worktree path and branch out of the registry and tool output.
export async function workspaceKey(configRoot) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: configRoot || process.cwd(), encoding: 'utf8', timeout: 3000 });
    return result.status === 0 ? result.stdout.trimEnd() : null;
  };
  const root = git('rev-parse', '--show-toplevel');
  const ref = root && (git('symbolic-ref', '--quiet', 'HEAD') ?? git('rev-parse', '--verify', 'HEAD'));
  if (root && !ref) throw Error('Не удалось определить ветку или HEAD рабочей копии.');
  const location = await realpath(root || configRoot || process.cwd());
  return createHash('sha256').update(JSON.stringify([location, ref || null])).digest('hex');
}
