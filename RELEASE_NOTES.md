## What's Changed in v1.1.6

• **WebKitWebProcess SIGILL / Crash Prevention (x86_64 AVX Detection)**:
  - Resolved desktop crash / freeze caused by WebKitGTK 2.52 JavaScriptCore JIT emitting AVX instructions (`vmovaps`) on x86_64 CPUs without AVX support (e.g. Intel Pentium N3710, Celeron, and older processors).
  - Added automatic runtime CPU feature check via `std::is_x86_feature_detected!("avx")` that safely disables JavaScriptCore JIT (`JSC_useJIT=0`) on CPUs lacking AVX instructions.

• **Plugin Market Sidebar Rail Relocation & Visibility Fix**:
  - Fixed Plugin Market disappearing from the interface; properly positioned as an independent launcher on the primary sidebar rail right above Settings and Help.
  - Fixed button mounting hierarchy: wrapped inside a native `tooltip-trigger` container sibling to prevent SolidJS / Kobalte re-renders from detaching the element.
  - Replaced crowded text button with native 32x32 `icon-button` (`data-variant="ghost"`, `data-size="large"`) matching OpenCode design system with smooth hover and active feedback.
  - Added multi-language button detection fallbacks (English, Turkish, etc.).
  - Added backdrop dismiss and Escape key shortcut to the standalone Plugin Market modal.

• **Subagent & Background Process Monitor Refinements**:
  - Aligned Subagent & Task Monitor rail button with native 32x32 icon button sizing and styling.
  - Added backdrop click and Escape key shortcuts for closing the monitor modal.

• **Packaging & Distribution**:
  - Bumped release version to `1.1.6`.
  - CI/CD workflow builds Linux standalone binary (`opencode-desktop`) and AppImage.

**Full Changelog**: https://github.com/tahayerd/opencode-tauri/compare/v1.1.5...v1.1.6
