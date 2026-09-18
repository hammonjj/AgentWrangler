# Codex integration and Electron boundary

## Runtime shape

The shared `AgentProvider` contract feeds `SessionStore` with provider-qualified keys. `ClaudeProvider` and `CodexProvider` own their native discovery formats; UI code receives only `AgentSession` values. Codex discovery scans recent rollout files using bounded head/tail reads and reparses only files whose modification time changed. SQLite is deliberately not a dependency because its schema is an implementation detail and may be locked by another client.

External Codex sessions remain observational. Their rollout lifecycle gives Busy, Possibly stuck, Waiting, and Done estimates, while their conversation pane follows the rollout file. Agent Wrangler never resumes an external thread merely to inspect it and never sends a process signal to a shared Codex host.

Wrangler-owned Codex conversations use `codex app-server --stdio`. `CodexAppServer` contains the JSON-RPC transport and `CodexRunner` reduces thread, turn, item, streaming, and approval events into the same block/composer contracts used by the existing pane. A pane subscription is disposable independently of the runner, so closing a view does not end work.

## Electron seam

The browser bundles use `createWebviewBridge`. In VSCode it wraps `acquireVsCodeApi`; an Electron preload can expose the same narrow `agentWranglerHost` object. Keep the renderer sandboxed, context isolated, and without Node integration. Filesystem access, process discovery, binary spawning, credentials, and App Server must remain in the main/backend process.

The remaining VSCode host APIs should move behind adapters before packaging Electron:

- configuration and versioned persistence (`globalState`, `workspaceState`, and `globalStorageUri` today);
- dialogs, notifications, clipboard, external URLs, file and diff opening;
- project/workspace discovery, integrated terminal navigation, and window focus;
- dictation permissions and platform process control.

The Electron application should run one backend per OS login, with renderer windows subscribing to snapshots. Runner ownership must use leases keyed by provider and thread so the VSCode extension and desktop app cannot both control one conversation. A renderer reload only reconnects. Surviving full application exit requires a separate daemon and is intentionally a later feature.

## Packaging hazards

- Resolve `claude` and `codex` from explicit settings plus platform locations; a binary inside a VSCode extension is not a durable desktop dependency.
- Keep spawned binaries and hook helpers outside ASAR. Re-test the Claude SDK ESM/CJS bundle under Electron.
- Store hook helpers in stable user data so an app update does not leave configuration pointing into an old versioned bundle.
- Migrate preferences, pins, nicknames, and local archives with a versioned schema. Do not migrate credentials or stale process ownership.
- macOS is the current process-control baseline. Windows, WSL, containers, SSH workspaces, signing, notarization, updates, tray behavior, and microphone entitlements need separate acceptance passes.
- Validate IPC senders and payloads. Do not expose raw IPC, filesystem, shell, or process APIs through the preload bridge.

## Compatibility behavior

Unknown rollout records are ignored, malformed lines do not abort a scan, and missing Codex directories produce an empty provider. If App Server cannot start, monitoring continues and only the new interactive thread fails with a visible error. Provider capabilities determine which actions appear; unsupported pause, resume, handoff, and external approval actions stay unavailable rather than targeting the wrong process.
