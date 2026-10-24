# MARRY BASE Android companion app

The Android app is a thin, native connection client for a MARRY BASE instance. It is intentionally
**not** a second management implementation: the app owns device-side configuration, validation and
transport policy, while every project workflow is served by the connected Management Studio.

## Native responsibilities

| Concern | Implementation |
| :--- | :--- |
| Address policy | `ServerAddress` (pure Java, unit-tested): scheme normalisation, path trimming (`/dashboard`, `/index.html`), rejection of credentials/query/fragment, HTTP restricted to loopback + RFC1918 + link-local + emulator loopback, HTTPS elsewhere. |
| Readiness | `ConnectionProbe` calls `GET /ready`, parses the server's dependency report and distinguishes “unreachable”, “wrong service”, “not ready” and “ready”. |
| Persistence | `SharedPreferences` (`marry_base`): last verified URL and verification timestamp. Config is never sent to a third party. |
| Transport policy | `network_security_config.xml` permits cleartext at the platform level (needed for LAN development); the app enforces the stricter policy above. Mixed content is never allowed; invalid TLS certificates cancel the connection. |
| Studio hosting | `WebView` loads `<server>/dashboard`. JavaScript + DOM storage are enabled (the studio uses them); file/content access and universal file access are disabled. |
| Navigation | Android back navigates WebView history first, then returns to the server settings screen. “Server” menu offers reload, change server, open in browser. |
| Error handling | Native dialog with retry / server-settings actions on main-frame load errors. |

Operator sign-in happens inside the studio, served from the operator's own origin. The app never
stores platform or project credentials; only the server address is persisted.

## Project layout

```
android/
├── build.gradle                  # AGP 8.2.2 plugin declaration
├── settings.gradle               # google()/mavenCentral(), :app
├── gradle.properties
├── gradlew, gradlew.bat          # Gradle 8.7 wrapper (wrapper jar committed)
├── gradle/wrapper/
└── app/
    ├── build.gradle              # compileSdk 34, minSdk 24, targetSdk 34
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── java/com/marrybase/platform/{MainActivity,ServerAddress,ConnectionProbe}.java
        │   └── res/{values,values-night?,xml,mipmap-*}
        └── test/java/com/marrybase/platform/ServerAddressTest.java
```

## Build

Requirements: JDK 17+, Android SDK with platform 34 and build-tools, `ANDROID_HOME` set (or
`android/local.properties` with `sdk.dir=`).

```bash
cd android
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug -PmarryVersionName=1.1.0 -PmarryVersionCode=2
```

From the repository root, `npm run android:build` runs the same Gradle target and copies the result
to `releases/marry-base.apk`, writing `releases/marry-base.apk.json` metadata.

### CI

`.github/workflows/ci.yml` job **Android Gradle build**:

1. Sets up Temurin JDK 17 and Gradle.
2. Runs the `ServerAddressTest` unit tests.
3. Runs `:app:assembleDebug`.
4. Fails if the APK is missing/empty, lacks `AndroidManifest.xml`, `classes.dex` or
   `resources.arsc`, or if `aapt2 dump badging` does not report `com.marrybase.platform` with
   `sdkVersion:'24'`.
5. Verifies the signature with `apksigner` and alignment with `zipalign -c 4`.
6. Uploads `marry-base-android-apk` (APK + metadata) and writes a summary with size and SHA-256.

The **Typecheck & integration tests** job downloads that artifact into `releases/` before running
`npm run verify:apk` and `npm test`, so the API serves and verifies a real package.

## Signing

- Debug builds are signed with the standard generated debug keystore. CI depends on this so the
  artifact is installable and verifiable.
- For distribution, configure a release keystore and enable `release` signing in
  `android/app/build.gradle`. **Keep the signing identity stable**; Android rejects updates signed
  by a different key. Never commit a keystore or its passwords.
- The server does not sign, patch or fabricate packages. `GET /v1/platform/apk/status` reports
  whether the artifact on disk is structurally valid, its SHA-256 and whether a Gradle build is
  possible on that host.

## Installing and functional testing

```bash
adb install -r releases/marry-base.apk
adb shell am start -n com.marrybase.platform/.MainActivity
```

Manual checklist (requires a device/emulator; not executed in this environment):

1. Enter `http://10.0.2.2:4100` (emulator) or the LAN URL; “Test connection” should show the
   server's readiness report.
2. Enter `http://example.com`; the app must refuse plain HTTP for a public host.
3. Enter a URL containing credentials; the app must refuse it.
4. Stop the server and reload; the native error dialog must appear with retry/settings.
5. “Verify & open Studio” should open the studio; back should return to settings.
6. Sign in, create a project, open its Overview.

## Known limitations

- The app is a WebView-hosted studio with a native connection experience, not an offline native
  management client. It requires network access to the instance.
- The studio inside the app is exactly the web studio; its mobile layout is responsive but not a
  separate native UI.
- No push notifications, background sync, biometric unlock or certificate pinning are implemented.
- Instrumented UI tests are not part of CI (no emulator in the sandbox); only JVM unit tests and
  build/package verification run automatically.
