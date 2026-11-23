package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
)

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

func enginePath(root, _ string) (string, error) {
	if len(enginePayload) == 0 || len(engineNotices) == 0 {
		return "", errors.New("Windows build is missing its embedded GoHarness engine or notices")
	}
	digest := sha256.Sum256(enginePayload)
	dir := filepath.Join(root, "engine", hex.EncodeToString(digest[:]))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "goh.exe")
	if err := materialize(path, enginePayload); err != nil {
		return "", err
	}
	if err := materialize(filepath.Join(dir, "notices.zip"), engineNotices); err != nil {
		return "", err
	}
	return path, nil
}

func materialize(path string, payload []byte) error {
	if data, err := os.ReadFile(path); err == nil && bytes.Equal(payload, data) {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".goh-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(payload)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return os.Rename(tmp.Name(), path)
}

func pruneEngines(root, active string) {
	parent := filepath.Join(root, "engine")
	entries, _ := os.ReadDir(parent)
	for _, entry := range entries {
		if entry.IsDir() && len(entry.Name()) == 64 {
			dir := filepath.Join(parent, entry.Name())
			if filepath.Dir(active) != dir {
				_ = os.RemoveAll(dir)
			}
		}
	}
}
