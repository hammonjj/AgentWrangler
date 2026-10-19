/*
 * Agent Wrangler.app's main executable (#142): Contents/MacOS/Agent Wrangler.
 *
 * It does one thing: exec the bundle's pinned Node on the launcher script,
 *
 *   Contents/Resources/node/bin/node Contents/Resources/app/dist/launcher/main.js [args]
 *
 * found relative to this executable, so the bundle works wherever it is put.
 * Everything else (starting the core daemon, the sign-in link, the browser)
 * is in launch.ts and main.ts beside this file.
 *
 * Why a compiled launcher rather than a shell script, or Node itself as
 * CFBundleExecutable:
 * - macOS attributes privacy grants and code-signing identity to the main
 *   executable. A signed Mach-O carries the bundle's identity
 *   (com.hammonjj.agentwrangler + the local signing certificate); a script's
 *   identity is its interpreter's.
 * - Node needs a script argument, and LaunchServices passes none. A copy of
 *   Node as the main executable would need its entry from the environment
 *   (LSEnvironment cannot hold a bundle-relative path), and would be a second
 *   50 MB Node in the bundle.
 * - exec, not spawn: the process LaunchServices started becomes the Node that
 *   does the work, and is gone when it is done.
 *
 * Built by scripts/package-app.ts with the system clang; no dependencies.
 * Arguments starting "-psn_" (a process serial number older macOS passes
 * apps) are dropped; anything else is passed on for the script to check.
 */
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  char exe[PATH_MAX];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0) {
    fprintf(stderr, "Agent Wrangler: executable path too long\n");
    return 127;
  }
  char real[PATH_MAX];
  if (realpath(exe, real) == NULL) {
    fprintf(stderr, "Agent Wrangler: cannot resolve %s: %s\n", exe, strerror(errno));
    return 127;
  }
  /* .../X.app/Contents/MacOS/X -> .../X.app/Contents */
  char macos[PATH_MAX];
  strlcpy(macos, dirname(real), sizeof macos);
  char contents[PATH_MAX];
  strlcpy(contents, dirname(macos), sizeof contents);

  char node[PATH_MAX];
  char entry[PATH_MAX];
  if (snprintf(node, sizeof node, "%s/Resources/node/bin/node", contents) >= (int)sizeof node ||
      snprintf(entry, sizeof entry, "%s/Resources/app/dist/launcher/main.js", contents) >= (int)sizeof entry) {
    fprintf(stderr, "Agent Wrangler: bundle path too long\n");
    return 127;
  }

  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (args == NULL) return 127;
  int n = 0;
  args[n++] = node;
  args[n++] = entry;
  for (int i = 1; i < argc; i++) {
    if (strncmp(argv[i], "-psn_", 5) == 0) continue;
    args[n++] = argv[i];
  }
  args[n] = NULL;

  execv(node, args);
  fprintf(stderr, "Agent Wrangler: cannot run %s: %s\n", node, strerror(errno));
  return 127;
}
