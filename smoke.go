package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/Sanidhya14321/goh-desktop/internal/desktop"
)

type smokeConfig struct {
	Projects []string `json:"projects"`
	Endpoint string   `json:"endpoint"`
	Report   string   `json:"report"`
	Mode     string   `json:"mode"`
}

func readSmoke(path string) (*smokeConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config smokeConfig
	err = json.Unmarshal(raw, &config)
	return &config, err
}
func (s *Service) SmokeConfig() *smokeConfig { return s.smoke }
func (s *Service) SmokeReport(report string, quit bool) error {
	if s.smoke == nil {
		return errors.New("smoke mode is available only in a development package with a fixture")
	}
	if err := os.WriteFile(s.smoke.Report, []byte(report+"\n"), 0600); err != nil {
		return err
	}
	if quit {
		s.app.Quit()
	}
	return nil
}

func (s *Service) SmokeExportSession(session desktop.Session, format string, includeTools bool) error {
	if s.smoke == nil || s.smoke.Mode != "workspace" {
		return errors.New("an active workspace fixture is required")
	}
	name := "session-test.md"
	if format == "json" {
		name = "session-test.json"
	}
	return s.host.Export(session, format, includeTools, filepath.Join(filepath.Dir(s.smoke.Report), name))
}

func (s *Service) SmokeFileReferences(session desktop.Session, paths []string) ([]string, error) {
	if s.smoke == nil || s.smoke.Mode != "workspace" {
		return nil, errors.New("an active workspace fixture is required")
	}
	return desktop.FileReferences(session.Project, paths)
}
