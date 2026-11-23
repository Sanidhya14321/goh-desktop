package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Sanidhya14321/goh-desktop/internal/updates"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

type updateService struct {
	mu      sync.Mutex
	updater *updater.Updater
	staged  string
	digest  []byte
}

func (u *updateService) init(app *application.App, key ed25519.PublicKey, dev bool) error {
	feed := updates.Feed{URL: feedURL, Channel: channel, Key: key, Fixture: dev}
	if err := app.Updater.Init(updater.Config{CurrentVersion: version, Channel: channel, Providers: []updater.Provider{feed}, PublicKey: key, Window: updater.WindowNone}); err != nil {
		return err
	}
	u.updater = app.Updater
	return nil
}
func (s *Service) UpdateStatus() string {
	if runtime.GOOS == "linux" {
		return "Ubuntu updates are installed through APT."
	}
	if s.updater.updater == nil {
		return "This build has no update feed."
	}
	return ""
}
func (s *Service) StageUpdate() (string, error) {
	u := &s.updater
	if u.updater == nil {
		return "", errors.New(s.UpdateStatus())
	}
	if !u.mu.TryLock() {
		return "", errors.New("an update is already being processed")
	}
	defer u.mu.Unlock()
	u.staged = ""
	u.digest = nil
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	rel, err := u.updater.Check(ctx)
	if err != nil || rel == nil {
		return "", err
	}
	if err := u.updater.DownloadAndInstall(ctx); err != nil {
		return "", err
	}
	artifact := u.updater.DownloadedPath()
	expected, _ := rel.Metadata["engine_tag"].(string)
	binary := artifact
	if runtime.GOOS == "darwin" {
		if filepath.Base(artifact) != appName()+".app" {
			return "", errors.New("the update archive does not contain the desktop app bundle")
		}
		binary = filepath.Join(artifact, "Contents", "MacOS", "goh-desktop")
		if info, err := os.Stat(filepath.Join(filepath.Dir(binary), "goh")); err != nil || !info.Mode().IsRegular() {
			return "", errors.New("the update archive is missing the bundled GoHarness engine")
		}
		if output, err := exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", artifact).CombinedOutput(); err != nil {
			return "", fmt.Errorf("staged macOS bundle signature verification failed: %s", strings.TrimSpace(string(output)))
		}

	}
	info, err := readPackageInfo(ctx, binary)
	if err != nil {
		return "", fmt.Errorf("inspect staged desktop and engine: %w", err)
	}
	if info.Desktop != rel.Version || info.Engine != strings.TrimPrefix(expected, "v") || info.Channel != channel {
		return "", errors.New("staged desktop, engine, or channel differs from the signed manifest")
	}
	u.staged = rel.Version
	u.digest = rel.Verification.Digest
	return u.staged, nil
}

func (s *Service) RestartForUpdate() error {
	u := &s.updater
	if !u.mu.TryLock() {
		return errors.New("an update is already being processed")
	}
	defer u.mu.Unlock()
	if u.staged == "" || u.updater == nil {
		return errors.New("stage a verified update first")
	}
	if err := s.host.BeforeRestart(); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		if err := verifyStagedExecutable(u.updater.DownloadedPath(), u.digest); err != nil {
			s.host.ResumeAfterFailedRestart()
			u.staged = ""
			return err
		}
	}
	if err := u.updater.Restart(context.Background()); err != nil {
		s.host.ResumeAfterFailedRestart()
		return err
	}
	return nil
}

func verifyStagedExecutable(path string, expected []byte) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return err
	}
	if !bytes.Equal(expected, digest.Sum(nil)) {
		return errors.New("staged Windows updater changed after verification; check again")
	}
	return nil
}
