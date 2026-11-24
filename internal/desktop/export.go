package desktop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func (h *Host) Export(session Session, format string, includeTools bool, destination string) error {
	if !filepath.IsAbs(destination) {
		return errors.New("choose an absolute export destination")
	}
	if format != "markdown" && format != "json" || includeTools && format != "markdown" {
		return errors.New("choose Markdown or a portable GoHarness archive")
	}
	root, err := os.OpenRoot(h.sessions)
	if err != nil {
		return err
	}
	file, _, header, err := openJournal(root, session.ID)
	root.Close()
	if err != nil {
		return err
	}
	file.Close()
	if !samePath(header.Project, session.Project) {
		return errors.New("session belongs to another project")
	}
	if _, err := h.Versions(); err != nil {
		return err
	}

	h.mu.Lock()
	if h.closed || h.restarting || h.exports[session.ID] {
		h.mu.Unlock()
		return errors.New("an export is running or the desktop is closing")
	}
	for active := range h.runs {
		if active.ID == session.ID {
			h.mu.Unlock()
			return errors.New("wait for this run to finish before exporting its session")
		}
	}
	h.exports[session.ID] = true
	h.operations++
	h.wg.Add(1)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.exports, session.ID)
		h.operations--
		h.mu.Unlock()
		h.wg.Done()
	}()

	ctx, cancel := context.WithTimeout(h.ctx, 45*time.Second)
	defer cancel()
	args := []string{"sessions", "export", session.ID, "--session-dir", h.sessions, "--format", format, "--output", destination}
	if includeTools {
		args = append(args, "--include-tools")
	}
	cmd := exec.CommandContext(ctx, h.binary, args...)
	cmd.Dir = h.root
	cmd.Env = processEnv()
	hideConsole(cmd)
	var diagnostics tail
	cmd.Stdout, cmd.Stderr = io.Discard, &diagnostics
	if err := cmd.Run(); err != nil {
		if details := diagnostics.String(); details != "" {
			return fmt.Errorf("export session: %s", details)
		}
		return fmt.Errorf("export session: %w", err)
	}
	return nil
}
