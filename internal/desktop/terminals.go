package desktop

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/Kodecable/crosspty"
)

type TerminalPacket struct {
	ID       string `json:"id"`
	Sequence int    `json:"sequence"`
	Data     []byte `json:"data,omitempty"`
	Exit     *int   `json:"exit,omitempty"`
}

type Shell struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Executable string `json:"-"`
}

func AvailableShells() []Shell {
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if !filepath.IsAbs(root) {
			root = `C:\Windows`
		}
		base := filepath.Join(root, "System32")
		shells := []Shell{{"default", "PowerShell", filepath.Join(base, "WindowsPowerShell", "v1.0", "powershell.exe")}, {"cmd", "Command Prompt", filepath.Join(base, "cmd.exe")}}
		if path, err := exec.LookPath("pwsh.exe"); err == nil && filepath.IsAbs(path) {
			shells = append(shells, Shell{"pwsh", "PowerShell 7", path})
		}
		return shells
	}
	defaultShell := os.Getenv("SHELL")
	if !filepath.IsAbs(defaultShell) || !executableFile(defaultShell) {
		defaultShell = "/bin/sh"
		if runtime.GOOS == "darwin" {
			defaultShell = "/bin/zsh"
		}
	}
	shells := []Shell{{"default", "Default (" + filepath.Base(defaultShell) + ")", defaultShell}}
	for _, name := range []string{"zsh", "bash", "fish", "sh"} {
		for _, dir := range []string{"/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"} {
			path := filepath.Join(dir, name)
			if executableFile(path) {
				shells = append(shells, Shell{name, name, path})
				break
			}
		}
	}
	return shells
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}

type terminal struct {
	pty     crosspty.Pty
	done    chan struct{}
	closing bool
	input   chan []byte
}

type Terminals struct {
	mu      sync.Mutex
	active  map[string]*terminal
	stopped bool
	emit    func(TerminalPacket)
}

func NewTerminals(emit func(TerminalPacket)) *Terminals {
	return &Terminals{active: make(map[string]*terminal), emit: emit}
}

func (t *Terminals) Start(id, directory, shellID string, cols, rows int) (Shell, error) {
	if !sessionID.MatchString(id) {
		return Shell{}, errors.New("invalid terminal ID")
	}
	directory, err := canonical(directory)
	if err != nil {
		return Shell{}, err
	}
	var chosen Shell
	for _, sh := range AvailableShells() {
		if sh.ID == shellID {
			chosen = sh
			break
		}
	}
	if chosen.Executable == "" {
		return Shell{}, errors.New("the selected shell is unavailable")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return Shell{}, errors.New("desktop is closing")
	}
	if _, exists := t.active[id]; exists {
		return Shell{}, errors.New("terminal already exists")
	}
	if len(t.active) >= 12 {
		return Shell{}, errors.New("close a terminal before opening another (limit 12)")
	}
	inject := map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor", "PWD": directory}
	// This is a user's interactive shell. It inherits their normal environment,
	// with the desktop-only provider key and engine bearer token removed.
	pty, err := crosspty.Start(crosspty.CommandConfig{
		Argv: []string{chosen.Executable}, Dir: directory, Env: processEnv(), EnvInject: inject,
		Size: terminalDimensions(cols, rows), CloseConfig: crosspty.CloseConfig{CloseTimeout: 3 * time.Second, KillDelay: time.Second},
	})
	if err != nil {
		return Shell{}, fmt.Errorf("start %s in %s: %w", chosen.Name, directory, err)
	}
	entry := &terminal{pty: pty, done: make(chan struct{}), input: make(chan []byte, 128)}
	t.active[id] = entry
	go t.read(id, entry)
	go func() {
		for input := range entry.input {
			if _, err := entry.pty.Write(input); err != nil {
				return
			}
		}
	}()
	return chosen, nil
}

func terminalDimensions(cols, rows int) crosspty.TermSize {
	return crosspty.TermSize{Cols: uint16(min(500, max(2, cols))), Rows: uint16(min(250, max(2, rows)))}
}

func (t *Terminals) read(id string, entry *terminal) {
	buf := make([]byte, 16<<10)
	seq := 0
	for {
		n, err := entry.pty.Read(buf)
		if n > 0 {
			seq++
			t.emit(TerminalPacket{ID: id, Sequence: seq, Data: append([]byte(nil), buf[:n]...)})
			if n == len(buf) {
				time.Sleep(12 * time.Millisecond)
			}
		}
		if err != nil {
			break
		}
	}
	t.mu.Lock()
	t.endInput(entry)
	t.mu.Unlock()
	// Always release both endpoints even if output closed before the shell.
	_ = entry.pty.Close()
	exit := entry.pty.Wait()
	t.mu.Lock()
	delete(t.active, id)
	close(entry.done)
	t.mu.Unlock()
	t.emit(TerminalPacket{ID: id, Sequence: seq + 1, Exit: &exit})
}

func (t *Terminals) endInput(entry *terminal) {
	if !entry.closing {
		entry.closing = true
		close(entry.input)
	}
}

func (t *Terminals) Write(id, text string) error {
	if len(text) > 64<<10 {
		return errors.New("terminal input chunk exceeds 64 KiB")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	entry := t.active[id]
	if entry == nil || entry.closing {
		return io.ErrClosedPipe
	}
	select {
	case entry.input <- []byte(text):
		return nil
	default:
		return errors.New("terminal input is busy")
	}
}

func (t *Terminals) Resize(id string, cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry := t.active[id]; entry != nil && !entry.closing {
		return entry.pty.Resize(terminalDimensions(cols, rows))
	}
	return nil
}

func (t *Terminals) Close(id string) error {
	t.mu.Lock()
	entry := t.active[id]
	if entry != nil {
		t.endInput(entry)
	}
	t.mu.Unlock()
	if entry == nil {
		return nil
	}
	if err := entry.pty.Close(); err != nil {
		return err
	}
	select {
	case <-entry.done:
		return nil
	case <-time.After(2 * time.Second):
		return errors.New("timed out closing terminal")
	}
}

func (t *Terminals) BeforeRestart() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.active) != 0 {
		return errors.New("close active terminals before restarting for the update")
	}
	t.stopped = true
	return nil
}

func (t *Terminals) Resume() {
	t.mu.Lock()
	t.stopped = false
	t.mu.Unlock()
}

func (t *Terminals) Shutdown() {
	t.mu.Lock()
	t.stopped = true
	ids := make([]string, 0, len(t.active))
	for id := range t.active {
		ids = append(ids, id)
	}
	t.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Go(func() { _ = t.Close(id) })
	}
	wg.Wait()
}
