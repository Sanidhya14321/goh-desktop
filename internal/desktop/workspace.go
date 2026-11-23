package desktop

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Workspace struct {
	Project      string            `json:"project"`
	Pins         []string          `json:"pins"`
	Tabs         []Session         `json:"tabs"`
	Active       string            `json:"active"`
	Names        map[string]string `json:"names"`
	Theme        string            `json:"theme"`
	Density      string            `json:"density"`
	FontSize     int               `json:"font_size"`
	TerminalSize int               `json:"terminal_size"`
	Shell        string            `json:"shell"`
	Sidebar      bool              `json:"sidebar"`
	Activity     bool              `json:"activity"`
	Restore      bool              `json:"restore"`
}

func (h *Host) Workspace() (Workspace, error) {
	w := Workspace{Theme: "ember", Density: "comfortable", FontSize: 13, TerminalSize: 32, Shell: "default", Sidebar: true, Activity: true, Restore: true}
	h.mu.Lock()
	defer h.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(h.root, "workspace.json"))
	if errors.Is(err, os.ErrNotExist) {
		return sanitizeWorkspace(w), nil
	}
	if err == nil {
		err = json.Unmarshal(data, &w)
	}
	return sanitizeWorkspace(w), err
}

func (h *Host) SaveWorkspace(w Workspace) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return writeJSON(h.root, "workspace.json", sanitizeWorkspace(w))
}

func sanitizeWorkspace(w Workspace) Workspace {
	switch w.Theme {
	case "ember", "graphite", "contrast":
	default:
		w.Theme = "ember"
	}
	if w.Density != "compact" {
		w.Density = "comfortable"
	}
	if w.FontSize < 11 || w.FontSize > 22 {
		w.FontSize = 13
	}
	if w.TerminalSize < 18 || w.TerminalSize > 62 {
		w.TerminalSize = 32
	}
	if len(w.Shell) > 20 || strings.ContainsAny(w.Shell, "\r\n\x00") {
		w.Shell = "default"
	}
	if !filepath.IsAbs(w.Project) {
		w.Project = ""
	}
	if !sessionID.MatchString(w.Active) {
		w.Active = ""
	}
	pins := make([]string, 0, min(25, len(w.Pins)))
	seen := make(map[string]bool)
	for _, path := range w.Pins {
		if !filepath.IsAbs(path) || len(path) > 4096 || seen[path] {
			continue
		}
		seen[path] = true
		pins = append(pins, path)
		if len(pins) == 25 {
			break
		}
	}
	tabs := make([]Session, 0, min(30, len(w.Tabs)))
	for _, session := range w.Tabs {
		if !filepath.IsAbs(session.Project) || len(session.Project) > 4096 || !sessionID.MatchString(session.ID) {
			continue
		}
		tabs = append(tabs, session)
		if len(tabs) == 30 {
			break
		}
	}
	names := make(map[string]string)
	for id, name := range w.Names {
		name = strings.TrimSpace(name)
		if !sessionID.MatchString(id) || name == "" || strings.ContainsAny(name, "\r\n\x00") {
			continue
		}
		runes := []rune(name)
		names[id] = string(runes[:min(80, len(runes))])
		if len(names) == 500 {
			break
		}
	}
	w.Pins, w.Tabs, w.Names = pins, tabs, names
	return w
}

func (h *Host) ForgetProject(project string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	filtered := make([]string, 0, len(h.projects))
	for _, path := range h.projects {
		if !samePath(project, path) {
			filtered = append(filtered, path)
		}
	}
	if err := writeJSON(h.root, "projects.json", filtered); err != nil {
		return err
	}
	h.projects = filtered
	return nil
}
