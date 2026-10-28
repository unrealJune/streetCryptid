const {
  assertAppDelegateDoesNotStartReact,
  patchSceneDelegate,
  SCENE_WILL_CONNECT,
} = require('../withDeferredReactNativeStart');

/**
 * The plugin's whole value is that it must not silently fail.
 *
 * `ios/` is regenerated from an Expo template on every prebuild and that template moves between
 * SDK patches. A transform that quietly matches nothing ships an app that boots React on every
 * background wake and looks completely healthy — the only symptom would be `wake.js_boots`
 * tracking `wake.bg_launches` in a dashboard nobody is looking at.
 */

/** The real SDK 58 template (expo-template-bare-minimum@58.0.30). */
const SCENE_TEMPLATE = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

/** The real SDK 58 AppDelegate, trimmed to the launch method. */
const APP_DELEGATE_58 = `@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    reactNativeFactory = factory

    // The window is created and React Native is started by \`SceneDelegate\` under the
    // scene-based life cycle (required by the iOS 27 SDK).
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

/** The body of one overridden Swift method, from its signature to the next `override`. */
function method(out, signature) {
  const start = out.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = out.indexOf('override func', start + signature.length);
  return out.slice(start, next === -1 ? undefined : next);
}

describe('withDeferredReactNativeStart', () => {
  it('gates the scene connection instead of always starting React', () => {
    const out = patchSceneDelegate(SCENE_TEMPLATE);
    const connect = method(out, 'willConnectTo session: UISceneSession');
    expect(connect).toContain('if Self.shouldStartReactNativeNow()');
    expect(connect).toContain('pendingConnection = (scene, session, connectionOptions)');
  });

  /**
   * The bootstrap classifies the launch from the scene's activation state, and it must have done
   * so before the gate reads the flag — so the post comes first, and it is synchronous.
   */
  it('lets the bootstrap classify the launch before it reads the decision', () => {
    const connect = method(
      patchSceneDelegate(SCENE_TEMPLATE),
      'willConnectTo session: UISceneSession'
    );
    const post = connect.indexOf(`Notification.Name("${SCENE_WILL_CONNECT}")`);
    expect(post).toBeGreaterThanOrEqual(0);
    expect(post).toBeLessThan(connect.indexOf('shouldStartReactNativeNow()'));
  });

  /** Dev-client builds must be byte-identical in behaviour; dev-launcher owns the other seam. */
  it('always starts immediately in DEBUG', () => {
    expect(patchSceneDelegate(SCENE_TEMPLATE)).toMatch(/#if DEBUG\s+return true/);
  });

  /**
   * One predicate, not two. The decision is made in `IrohBackgroundAppDelegateSubscriber` and
   * published through UserDefaults, because the generated delegate cannot import that module.
   */
  it('reads the published decision rather than deciding again', () => {
    const out = patchSceneDelegate(SCENE_TEMPLATE);
    expect(out).toContain('sc.bg.rn_deferred');
    expect(out).not.toContain('applicationState');
    // The connect-time decision is the published one, never a second reading of the scene.
    const connect = method(out, 'willConnectTo session: UISceneSession');
    expect(connect.slice(0, connect.indexOf('static func'))).not.toContain('activationState');
  });

  /** Coming to the foreground — someone opened the app — is what starts a deferred React. */
  it.each(['sceneWillEnterForeground(_ scene: UIScene)', 'sceneDidBecomeActive(_ scene: UIScene)'])(
    'starts React before forwarding %s',
    (signature) => {
      const body = method(patchSceneDelegate(SCENE_TEMPLATE), signature);
      const start = body.indexOf('startReactNativeIfNeeded()');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThan(body.indexOf('super.'));
    }
  );

  /**
   * The invariant: React starts only for a scene on its way to the screen. A link or activity
   * delivered to a held-back scene still in the background is queued, not a reason to start; one
   * delivered to a foreground scene starts React before `super` hands it to RCTLinkingManager.
   */
  it.each([
    [
      'openURLContexts URLContexts: Set<UIOpenURLContext>',
      'pendingURLContexts.append(URLContexts)',
    ],
    ['continue userActivity: NSUserActivity', 'pendingActivities.append(userActivity)'],
  ])('queues %s on a background scene instead of starting React', (signature, queue) => {
    const body = method(patchSceneDelegate(SCENE_TEMPLATE), signature);
    const hold = body.indexOf('if holdsDelivery(for: scene) {');
    expect(hold).toBeGreaterThanOrEqual(0);
    const held = body.slice(hold, body.indexOf('}', hold));
    expect(held).toContain(queue);
    expect(held).toContain('return');
    expect(held).not.toContain('startReactNativeIfNeeded');
    // Past the hold, React is started before the delivery is forwarded.
    expect(body.indexOf('startReactNativeIfNeeded()')).toBeGreaterThan(hold);
    expect(body.indexOf('startReactNativeIfNeeded()')).toBeLessThan(body.indexOf('super.'));
  });

  it('holds a delivery only while React is held back and the scene is in the background', () => {
    expect(patchSceneDelegate(SCENE_TEMPLATE)).toMatch(
      /func holdsDelivery\(for scene: UIScene\) -> Bool \{\s+pendingConnection != nil && scene\.activationState == \.background\s+\}/
    );
  });

  /** Every path that starts React is listed above; nothing else may call it. */
  it('starts React from nowhere but the foreground and a foreground delivery', () => {
    const out = patchSceneDelegate(SCENE_TEMPLATE);
    const callers = out.split('startReactNativeIfNeeded()').length - 1;
    // The definition, the two foreground hooks and the two deliveries.
    expect(callers).toBe(5);
  });

  it('replays queued links after starting React', () => {
    const body = method(patchSceneDelegate(SCENE_TEMPLATE), 'func startReactNativeIfNeeded()');
    const start = body.indexOf('willConnectTo: pending.session');
    expect(body.indexOf('openURLContexts: contexts')).toBeGreaterThan(start);
    expect(body.indexOf('continue: activity')).toBeGreaterThan(start);
  });

  /** Replaying the ORIGINAL options is what keeps a cold-start link reaching getInitialURL. */
  it('replays the held-back connection into super exactly once', () => {
    const body = method(patchSceneDelegate(SCENE_TEMPLATE), 'func startReactNativeIfNeeded()');
    expect(body).toMatch(
      /guard let pending = pendingConnection else \{ return \}\s+pendingConnection = nil/
    );
    expect(body).toContain(
      'super.scene(pending.scene, willConnectTo: pending.session, options: pending.options)'
    );
  });

  it('is idempotent', () => {
    const once = patchSceneDelegate(SCENE_TEMPLATE);
    expect(patchSceneDelegate(once)).toBe(once);
  });

  /** The load-bearing behaviour: a template it does not recognise is a hard failure. */
  it('throws rather than no-oping on an unrecognised template', () => {
    const changed = SCENE_TEMPLATE.replace('// Extension point for config plugins.', '');
    expect(() => patchSceneDelegate(changed)).toThrow(/could not find the template SceneDelegate/);
  });

  it('accepts the SDK 58 AppDelegate, which leaves React to the scene', () => {
    expect(() => assertAppDelegateDoesNotStartReact(APP_DELEGATE_58)).not.toThrow();
  });

  /** An AppDelegate that still starts React bypasses the scene gate entirely. */
  it('rejects an AppDelegate that starts React itself', () => {
    const legacy = APP_DELEGATE_58.replace(
      '    return super.application',
      '    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)\n    return super.application'
    );
    expect(() => assertAppDelegateDoesNotStartReact(legacy)).toThrow(/calls startReactNative/);
  });
});
