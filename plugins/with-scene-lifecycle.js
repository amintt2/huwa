// iOS 27 asserts at launch unless the app adopts the UIScene life cycle.
// Expo 57 ships `ExpoAppSceneDelegate` for this, but the prebuild template does not wire it yet.
// This plugin: declares the scene manifest and lets the scene delegate create the window.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('with-scene-lifecycle: only Swift AppDelegate is supported');
    }
    let src = cfg.modResults.contents;

    // 1. The scene delegate reads the factory through this protocol.
    if (!src.includes('ExpoReactNativeFactoryProvider')) {
      src = src.replace(
        /class AppDelegate: ExpoAppDelegate \{/,
        'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
      );
    }

    // 2. The window is now created by the scene delegate, not at launch.
    src = src.replace(
      /#if os\(iOS\) \|\| os\(tvOS\)\s*\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n\s*factory\.startReactNative\([\s\S]*?\)\s*\n#endif\s*\n/,
      '',
    );

    if (src.includes('UIWindow(frame: UIScreen.main.bounds)')) {
      throw new Error('with-scene-lifecycle: AppDelegate template changed, update the plugin');
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = (config) => withSceneAppDelegate(withSceneManifest(config));
