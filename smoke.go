package main

import (
	"encoding/json"
	"errors"
	"os"
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
