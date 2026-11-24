# Workspace and keyboard workflows

## How do comparable apps make multiple projects legible?

### Takeaway

Both comparators preserve project context even when several roots or projects are visible. The low-cost adaptation is visible identity, actions anchored to the project they affect, and reliable return to the last session in each project.

### Cited Findings

- VS Code shows each folder as a root, supports multiple folder selection through its native open dialog, and exposes adding and removing folders through the File menu and root context menu. [VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
- VS Code places a folder name in tab headers when file names collide and includes folder names in Quick Open results. Its multi-root search groups results by folder and can scope a query to one root. [VS Code multi-root workspace general UI](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces#general-ui)
- Zed’s projects in one window retain project-local file trees, Git state, search scope, threads, tabs and splits. Clicking a project header can expand its threads, while a modifier click activates the project. Its Open Recent picker defaults to the current window. [Zed Windows & Projects](https://zed.dev/docs/windows-and-projects#working-with-multiple-projects)
- GoHarness already persists workspace session restoration and provides project and session tabs. In the audited implementation, two project rows with the same basename rely on the tooltip to distinguish them, and selecting a project picks the last matching tab by insertion order rather than the last-used session. [Current GoHarness navigation](frontend/src/main.ts#L121)

### Inferences

- Add a short parent/path label only for ambiguous project names, while keeping the full path accessible. Use it consistently in project rows, palette results and session tabs. Preserve selection by canonical project path, never by basename.
- Remember last-focused session per project, independently of global tab order. Restore surviving sessions if a prior folder has moved or been removed. Keep discoverable contextual project actions near the project name rather than requiring the user to select a project and then find a global button.
- Native multi-select and file search can be evaluated later. The current project state and action pain points can be addressed without adding a full file explorer or multi-root editing layer.

### Gaps

- This audit used official product documentation and actual source reading, without representative users or measured task timings. Proposed priorities are product judgments grounded in documented workflows.

## Which navigation and terminal improvements fit the current architecture?

### Takeaway

Contextual terminal launch and a discoverable keyboard picker improve frequent workflows using the app’s existing terminal and project primitives. Keep the actual launch context explicit, especially when the user switches projects while terminals remain open.

### Cited Findings

- Zed provides a dedicated command palette using Cmd/Ctrl+Shift+P and a separate Cmd/Ctrl+P file finder that matches filenames or path fragments. Its tab switcher runs in most-recently-used order. [Zed Finding & Navigating](https://zed.dev/docs/finding-navigating) [Zed Command Palette](https://zed.dev/docs/command-palette)
- VS Code allows opening an integrated terminal directly from a folder’s Explorer context menu. Terminals start in the selected folder by default. Split behaviors are defined, adjustable and differ by platform. Terminal IDs are supplemented by name, icon, and status. [VS Code Terminal Basics](https://code.visualstudio.com/docs/terminal/basics)
- Zed’s built-in terminal uses the current project directory by default and exposes alternative directory policies. [Zed terminal working directory](https://zed.dev/docs/terminal#working-directory)
- VS Code supports renaming terminal tabs from a context menu. Dynamic current working directory tracking requires shell integration and has cross-platform caveats. [VS Code getting started with the terminal](https://code.visualstudio.com/docs/terminal/getting-started) [VS Code terminal shell integration](https://code.visualstudio.com/docs/terminal/shell-integration#current-working-directory-detection)
- Local audit identified four specific friction points. New Session returns immediately after the folder picker even if a project was successfully chosen. The palette uses a single ungrouped substring list. The Open Terminal path consults mutable selected-project state after awaiting the terminal module. A split with one open terminal starts the new shell in the passed-in project, which can be unrelated to the source pane. [GoHarness main.ts](frontend/src/main.ts#L484) [GoHarness terminals.ts](frontend/src/terminals.ts#L133)

### Inferences

- Make the folder picker resume the initiating action after successful selection. Keep cancellation inert. For a project-row New Terminal action, capture that row’s folder before awaiting lazy loading and leave the active session’s project unchanged. If improving splits, use source pane launch directory and label it accordingly rather than promising live cwd tracking.
- Keep Cmd/Ctrl+K available and add the familiar Cmd/Ctrl+Shift+P alias. Group existing palette items by command, project, and session, and support weighted prefix and fuzzy match for abbreviations. Keep exact names ahead of fuzzy matches. Avoid running a hidden/default command when no result matches.
- Use keyboard navigation and focus checks across arrow keys, Enter and Escape. Ensure the new shortcut does not steal unmodified terminal input. Terminal tab renaming or profile choice can remain a next increment after the core launch workflow is reliable.

### Gaps

- Docs establish supported workflows and defaults, not how often customers use each one. Native keyboard delivery, focus restoration, and shell behavior still need local and cross-platform smoke checks.
