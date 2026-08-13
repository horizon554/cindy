import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('iOS Simulator capability teardown wiring', () => {
  const brainSource = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const makerIpcSource = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('routes the plugin-page project disable through the capability FIFO and scoped cleanup', () => {
    const start = brainSource.indexOf("'ghosts:workdir-prefs:set'");
    const end = brainSource.indexOf("ipcMain.handle('ghosts:cindy-prefs:set'", start);
    const handler = brainSource.slice(start, end);

    expect(handler).toContain('assertTrustedAppRendererEvent(event);');
    expect(handler).toContain("ghost.manifest.slots.includes('ios-simulator')");
    expect(handler).toContain('runIOSSimulatorCapabilityMutation(mutate)');
    expect(handler).toMatch(
      /releaseIOSSimulatorAfterCapabilityLoss\(\s*hadEnabledIOSSimulatorCapability,\s*\{ projectWorkingDirs: \[workdir\] \},\s*true,?\s*\)/,
    );
  });

  it('lets a repeated plugin disable retry cleanup while the Host remains active', () => {
    const start = brainSource.indexOf("ipcMain.handle('ghosts:set-enabled'");
    const end = brainSource.indexOf("ipcMain.handle('ghosts:runtime-states'", start);
    const handler = brainSource.slice(start, end);

    expect(handler).toMatch(
      /releaseIOSSimulatorAfterCapabilityLoss\(\s*hadEnabledIOSSimulatorCapability,\s*\{\},\s*true,?\s*\)/,
    );
  });

  it('combines provider and built-in-tool access for each project binding', () => {
    const start = makerIpcSource.indexOf(
      'const isIOSSimulatorProviderEnabledForProject = (workingDir: string): boolean => {',
    );
    const end = makerIpcSource.indexOf('const runBuiltinToolMutation', start);
    const providerWiring = makerIpcSource.slice(start, end);

    expect(providerWiring).toContain('getIOSSimulatorPluginAccessDecision(workingDir).allowed');
    expect(providerWiring).toContain("registry.isEnabled('ios-simulator', workingDir)");
    expect(providerWiring).toContain('configureIOSSimulatorActiveProviderResolver({');
    expect(providerWiring).toContain(
      'isEnabledForProject: isIOSSimulatorProviderEnabledForProject',
    );
  });
});
