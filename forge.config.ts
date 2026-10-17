import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.tokyo.goalcoach',
    executableName: 'goal-coach',
    extendInfo: {
      NSCameraUsageDescription:
        'Goal Coach uses the camera to observe visible phone use relevant to your goal during a focus session.'
    }
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_config, result) => {
      if (result.platform !== 'darwin') return;
      // Seal the finished bundle after Packager has changed its name and Info.plist.
      // This is local development signing; Developer ID/notarization remain separate.
      for (const outputPath of result.outputPaths) {
        const appPath = join(outputPath, 'Goal Coach.app');
        await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
        await execFileAsync('codesign', ['--verify', '--deep', '--strict', appPath]);
      }
    },
  },
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main'
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload'
        }
        ,{ entry: 'src/capture-preload.ts', config: 'vite.capture-preload.config.ts', target: 'preload' }
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }]
    })
  ]
};

export default config;
