# Integrated terminal usability

## How do users identify, switch, and split terminal sessions?

### Takeaway
Give each terminal a recognizable title and keep the project visible beside it. Make the target of split actions explicit, especially when a project, terminal, and agent session can each have different focus.

### Cited Findings
- Warp's optional vertical tab layout exposes pane directory, branch, and status. It filters panes by title, directory, or branch and allows inline rename by double-click. Its unified add menu includes both terminal and agent tabs. [Warp Vertical Tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/#tab-management)
- Windows Terminal provides tab search, rename and reset commands, and direct tab switching. Its split action can duplicate the focused pane's profile, or it can accept a specific profile and starting directory. [Microsoft Learn Windows Terminal actions](https://learn.microsoft.com/windows/terminal/customize-settings/actions#tab-management-commands)
- VS Code exposes split actions on terminal tabs and in their context menu, and it has commands for focusing the next or previous split pane. It lets users set the starting directory behavior for splits. [VS Code Terminal Basics](https://code.visualstudio.com/docs/terminal/basics#_groups-split-panes)

### Inferences
- Use GoHarness’s current horizontal dock and command palette. Let a user rename a terminal from an accessible control and search by the custom title or project path in the palette. Keep titles separate from GoHarness agent session names. Keep rename in memory for the lifetime of the current PTY.
- Make the terminal panel button explicitly a layout toggle if it shows another existing pane. A separately labeled “New terminal in split” should predictably start a shell in the named project, with the existing terminal retaining its process.
- Make keyboard and visual focus agree. When a palette result selects a live terminal, show its dock and focus its emulator. Make the focused pane visually distinct and give it an accessible name including the terminal title and project. Show failed or exited states in text as well as color.
- Acceptance checks should use two terminals in different projects with duplicate default titles, rename one, reopen it through a title or project search, and check that the other receives no typed input.

### Gaps
- Product docs describe behavior but provide no comparative task-time or error-rate data.

## How do users find output without disrupting shell shortcuts?

### Takeaway
Search the focused terminal's locally buffered output. Keep shell control keys working and put Find behind a platform-appropriate shortcut, a labeled control, and the command palette.

### Cited Findings
- Windows Terminal defaults to Ctrl+Shift+F for terminal search. Each focused pane searches its own text buffer. The UI allows moving through matches in either direction and toggling case matching. [Microsoft Learn Windows Terminal Search](https://learn.microsoft.com/en-us/windows/terminal/search)
- VS Code's integrated terminal has a Find command on Cmd+F for macOS and Ctrl+F on Windows and Linux. Its documentation specifically explains how to send Ctrl+F back to the shell. [VS Code Terminal Basics](https://code.visualstudio.com/docs/terminal/basics#_find)
- VS Code documents selective application shortcut interception in the focused terminal. It also notes that Cmd+K commonly clears macOS terminal content and offers contextual behavior. [VS Code Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced#_keyboard-shortcuts-and-the-shell)

### Inferences
- GoHarness can use Cmd+F in its macOS terminal and Ctrl+Shift+F in its Windows/Linux terminal, protecting shell-side Ctrl+F where relevant. Keep ordinary shell controls such as Ctrl+C and Ctrl+R. Handle search only when its terminal is available.
- Match navigation should provide Enter and Shift+Enter, explicit close, no-match or match count feedback when available, and Escape returning focus to the same terminal. Preserve the shell buffer and leave focus in the search field while navigating.
- Keep search local to the in-memory buffer. An xterm search add-on aligns with the existing frontend model and avoids indexing, persisting, or transmitting shell output. If added as a frontend dependency, include its notice in the packager.
- Acceptance checks should emit different markers in each paned shell, confirm that one marker cannot be found from the other pane, and check search dismissal followed by ordinary shell input.

### Gaps
- The source docs do not establish a single shared Linux terminal shortcut convention. Scoped Ctrl+Shift+F is a conservative GoHarness decision.

## What do close actions and restoration promise?

### Takeaway
Keep hide, close, and quit behavior distinct. Restoration should say whether it restores a layout, output, or a still-running process.

### Cited Findings
- Windows Terminal has a default-enabled confirmation for closing a window with multiple tabs, and its action docs differentiate quitting, closing a window, and closing the focused tab. [Windows Terminal Appearance Settings](https://learn.microsoft.com/windows/terminal/customize-settings/appearance#show-close-all-tabs-popup) · [Microsoft Learn Windows Terminal actions](https://learn.microsoft.com/windows/terminal/customize-settings/actions)
- VS Code has separate confirm-on-window-exit and confirm-on-terminal-kill settings. Its persistence docs distinguish reconnecting to a still-running process when reloading a window from relaunching a process and restoring output after an app restart. [VS Code Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)
- Warp restores window, tab, pane and recent block state using a local database. It documents that disabling restoration stops further recording and does not remove already saved output. [Warp Session Restoration](https://docs.warp.dev/terminal/sessions/session-restoration/)
- VS Code shows live terminal CWD on Windows only with shell integration. Windows Terminal documents that PowerShell's location may not match the process CWD, so cloning the visible shell directory can depend on the shell reporting it. [VS Code terminal appearance](https://code.visualstudio.com/docs/terminal/appearance#_tabs) · [Windows Terminal same-directory tutorial](https://learn.microsoft.com/windows/terminal/tutorials/new-tab-same-directory)

### Inferences
- “Hide terminal panel” should preserve running shells; “Close terminal” should clearly terminate the one shell. A close-window confirmation should tell the user what ongoing terminal or agent work will end, but should avoid treating remembered session tabs as running processes. Consider a configurable warning if there is appetite for further settings.
- Persist small preferences and the persisted GoHarness agent session list. Do not describe a fresh shell as continued or persist shell output as a side effect of an ordinary settings change. If terminal layout reopening is added later, explicitly describe it as opening fresh shells.
- Use “Project” or “Started in” for the directory stored at launch. Do not label it live working directory before supporting shell-reported changes across all intended platforms.

### Gaps
- Compared vendors don't establish how to reliably detect arbitrary child work in an interactive GoHarness PTY across every host shell. A confirmation based on all live shells is feasible, while a foreground-job-only prompt needs more design and testing.
