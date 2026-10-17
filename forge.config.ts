import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

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
