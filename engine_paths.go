//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

func enginePath(_ string, exe string) (string, error) {
	return filepath.Join(filepath.Dir(exe), "goh"), nil
}
func pruneEngines(_, _ string) {}

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
