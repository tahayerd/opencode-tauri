## What's Changed in v1.1.7

• **Plugin Market Restored to Settings Dialog**:
  - Restored the native Plugin Market tab directly inside the Settings dialog under the Server section (matching the stable v1.1.0 layout).
  - Maintained configuration reconciliation between `plugin` (singular) and `plugins` (plural) keys in `opencode.json`.

• **WebKitWebProcess SIGILL Crash Fix Maintained**:
  - Maintained runtime CPUID AVX detection (`std::is_x86_feature_detected!("avx")`) in `lib.rs`, automatically setting `JSC_useJIT=0` on non-AVX x86_64 processors (Intel Pentium N3710, Celeron) to prevent crashes.

• **Packaging & Distribution**:
  - Bumped release version to `1.1.7`.
  - Automated CI build producing standalone binary (`opencode-desktop`) and AppImage.

**Full Changelog**: https://github.com/tahayerd/opencode-tauri/compare/v1.1.6...v1.1.7
