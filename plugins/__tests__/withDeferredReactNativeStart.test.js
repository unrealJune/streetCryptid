const { patchAppDelegate } = require('../withDeferredReactNativeStart');

/**
 * The plugin's whole value is that it must not silently fail.
 *
 * `ios/` is regenerated from an Expo template on every prebuild and that template moves between
 * SDK patches. A transform that quietly matches nothing ships an app that boots React on every
 * background wake and looks completely healthy — the only symptom would be `wake.js_boots`
 * tracking `wake.bg_launches` in a dashboard nobody is looking at.
 */

/** The real SDK 57 template, trimmed to the parts the transform touches. */
const TEMPLATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}
`;

describe('withDeferredReactNativeStart', () => {
  it('replaces the unconditional start with a gated one', () => {
    const out = patchAppDelegate(TEMPLATE);
    expect(out).not.toMatch(/^\s*factory\.startReactNative\(/m);
    expect(out).toContain('shouldStartReactNativeNow(application)');
    expect(out).toContain('startReactNativeIfNeeded()');
  });

  /** Dev-client builds must be byte-identical in behaviour; dev-launcher owns the other seam. */
  it('always starts immediately in DEBUG', () => {
    const out = patchAppDelegate(TEMPLATE);
    expect(out).toMatch(/#if DEBUG\s+return true/);
  });

  /**
   * One predicate, not two. The decision is made in `IrohBackgroundAppDelegateSubscriber` (which
   * runs in `willFinishLaunchingWithOptions`, before this) and published through UserDefaults,
   * because the generated AppDelegate cannot import that module. Two copies would drift, and the
   * pair that disagrees is a mounted app that cannot claim its own node. The kill switch lives
   * with the decision, not here.
   */
  it('reads the published decision rather than deciding again', () => {
    const out = patchAppDelegate(TEMPLATE);
    expect(out).toContain('sc.bg.rn_deferred');
    expect(out).not.toContain('applicationState != .background');
  });

  /**
   * A deep or universal link can arrive on a process that has only ever been a background one,
   * and both handlers assume a live bridge via RCTLinkingManager.
   */
  it('starts React from all three foreground entry points', () => {
    const out = patchAppDelegate(TEMPLATE);
    expect(out).toContain('applicationWillEnterForeground');
    const openUrl = out.slice(out.indexOf('open url: URL'));
    expect(openUrl).toContain('startReactNativeIfNeeded()');
    const continueUserActivity = out.slice(out.indexOf('continue userActivity: NSUserActivity'));
    expect(continueUserActivity).toContain('startReactNativeIfNeeded()');
  });

  it('is idempotent', () => {
    const once = patchAppDelegate(TEMPLATE);
    expect(patchAppDelegate(once)).toBe(once);
  });

  /** The load-bearing behaviour: a template it does not recognise is a hard failure. */
  it('throws rather than no-oping on an unrecognised template', () => {
    const changed = TEMPLATE.replace('withModuleName: "main"', 'withModuleName: "somethingElse"');
    expect(() => patchAppDelegate(changed)).toThrow(/could not find the startReactNative block/);
  });
});
