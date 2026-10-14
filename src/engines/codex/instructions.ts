import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Load the same user/ancestor CLAUDE.md rules without creating a second editable copy. */
export function sharedClaudeInstructions(cwd: string): string {
  const paths: string[] = [path.join(os.homedir(), '.claude', 'CLAUDE.md')];
  let parent = path.dirname(path.resolve(cwd));
  const ancestors: string[] = [];
  while (true) {
    ancestors.unshift(path.join(parent, 'CLAUDE.md'));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  paths.push(...ancestors);
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const file of paths) {
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      const text = fs.readFileSync(real, 'utf8');
      if (text.trim()) sections.push(`## Shared workspace instructions: ${file}\n${text}`);
    } catch {
      /* Missing instruction files are normal. */
    }
  }
  sections.push(
    'The workspace AGENTS.md / CLAUDE.md contains bot-specific instructions. Follow those together with the shared rules above. Claude-specific runtime commands are implemented by the Luckagent bridge for Codex.',
  );
  return sections.join('\n\n');
}
