## What's Changed in v1.1.7

• **Home Screen (Ana Ekran) Navigation Button Placement**:
  - Added dedicated launcher buttons for **Plugin Market** and **Agent Monitor** directly into the Home screen project sidebar navigation (`HomeUtilityNav`), seamlessly positioned above Settings ("Ayarlar") and Help ("Yardım").
  - Matches the exact native layout and styling of OpenCode's home navigation row items (`h-7`, `rounded-[6px]`, label truncation, and subtle hover state).
  - Maintained accessibility in both Home screen navigation and session/project sidebar rails.

• **WebKitWebProcess SIGILL / Crash Prevention (x86_64 AVX Detection)**:
  - Runtime CPUID detection via `std::is_x86_feature_detected!("avx")` automatically disables JavaScriptCore JIT (`JSC_useJIT=0`) on CPUs lacking AVX instructions (e.g., Intel Pentium N3710, Celeron).

• **Packaging & Distribution**:
  - Bumped release version to `1.1.7`.
  - Automated release pipeline producing AppImage and standalone Linux executable (`opencode-desktop`).

**Full Changelog**: https://github.com/tahayerd/opencode-tauri/compare/v1.1.6...v1.1.7
