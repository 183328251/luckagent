import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

describe('PTY hook bridge — generated --settings', () => {
  it('declares bypass-disclaimer consent alongside the Stop hook', async () => {
    const bridge = createHookBridge();
    try {
      const settings = JSON.parse(readFileSync(await bridge.writeSettings(), 'utf8'));
      // claude ≥2.1.29x ignores ~/.claude.json's bypassPermissionsModeAccepted;
      // without this the "Bypass Permissions mode" dialog (default "No, exit")
      // blocks every fresh machine. flagSettings scope = luckagent's claude only.
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.hooks?.Stop).toBeDefined();
    } finally {
      await bridge.dispose();
    }
  });
});
