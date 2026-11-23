package main

import (
	"crypto/ed25519"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/Sanidhya14321/goh-desktop/internal/desktop"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

// Build variables are set by the native packaging scripts.
var (
	version       = "0.1.0"
	engineVersion = ""
	channel       = "dev"
	development   = "1"
	feedURL       = ""
	updateKey     = ""
)

//go:embed all:frontend/dist
var assets embed.FS

type Service struct {
	terminals *desktop.Terminals
	host      *desktop.Host
	app       *application.App
	window    *application.WebviewWindow
	updater   updateService
	smoke     *smokeConfig
}

func run() error {
	// Dispatch Wails' detached updater before doing any startup work.
	updater.HandleHelperMode()
	exe, err := executable()
	if err != nil {
		return err
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	root = filepath.Join(root, appName())
	dev := development == "1"
	if dev && os.Getenv("GOH_DESKTOP_DATA_DIR") != "" {
		root = os.Getenv("GOH_DESKTOP_DATA_DIR")
	}
	probe := len(os.Args) == 2 && os.Args[1] == "--package-info"
	if probe {
		root, err = os.MkdirTemp("", "goh-desktop-probe-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(root)
	}
	var binary string
	if dev {
		binary = os.Getenv("GOH_DESKTOP_ENGINE")
	}
	override := binary != ""
	if !override {
		binary, err = enginePath(root, exe)
		if err != nil {
			return err
		}
	}
	versions := desktop.Versions{Desktop: version, Channel: channel}
	s := &Service{}
	s.terminals = desktop.NewTerminals(func(packet desktop.TerminalPacket) { s.app.Event.Emit("terminal:output", packet) })
	expected := engineVersion
	if override {
		expected = ""
	}
	h, err := desktop.New(root, binary, versions, expected, override, func(id string, frames []desktop.Frame) {
		s.app.Event.Emit("session:frames", map[string]any{"id": id, "frames": frames})
	})
	if err != nil {
		return err
	}
	closeHost := sync.OnceFunc(func() { s.terminals.Shutdown(); h.Close() })
	defer closeHost()
	s.host = h
	if probe {
		info, err := h.Versions()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(info)
	}
	if dev && os.Getenv("GOH_DESKTOP_SMOKE") != "" {
		s.smoke, err = readSmoke(os.Getenv("GOH_DESKTOP_SMOKE"))
		if err != nil {
			return err
		}
	}
	cfg := application.Options{
		OnShutdown: closeHost,
		Name:       appName(), Description: "GoHarness project sessions",
		Assets:   application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services: []application.Service{application.NewService(s)},
		SingleInstance: &application.SingleInstanceOptions{UniqueID: "io.goharness.desktop." + channel, OnSecondInstanceLaunch: func(_ application.SecondInstanceData) {
			if s.window != nil {
				s.window.Show()
				s.window.Focus()
			}
		}},
		Mac:     application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Windows: application.WindowsOptions{WebviewUserDataPath: filepath.Join(root, "webview")},
	}
	s.app = application.New(cfg)
	if !override && runtime.GOOS == "windows" {
		if _, err := h.Versions(); err == nil {
			pruneEngines(root, binary)
		}
	}
	key, err := base64.StdEncoding.DecodeString(updateKey)
	if err != nil || (updateKey != "" && len(key) != ed25519.PublicKeySize) {
		return errors.New("invalid pinned update key")
	}
	if runtime.GOOS != "linux" && len(key) > 0 && feedURL != "" {
		if err := s.updater.init(s.app, key, dev); err != nil {
			return err
		}
	}
	s.window = s.app.Window.NewWithOptions(application.WebviewWindowOptions{Title: appName(), Width: 1250, Height: 810, MinWidth: 720, MinHeight: 500, URL: "/", BackgroundColour: application.NewRGB(24, 23, 21), Windows: application.WindowsWindow{Theme: application.Dark}, Mac: application.MacWindow{Appearance: application.NSAppearanceNameDarkAqua}})
	s.configureMenu()
	return s.app.Run()
}
func appName() string {
	if channel == "preview" {
		return "GoHarness Desktop Preview"
	}
	return "GoHarness Desktop"
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		// GUI builds may not have a console. Keep a local startup diagnostic.
		if dir, e := os.UserConfigDir(); e == nil {
			root := filepath.Join(dir, "GoHarness Desktop")
			if os.MkdirAll(root, 0700) == nil {
				_ = os.WriteFile(filepath.Join(root, "startup.log"), []byte(fmt.Sprintln(err)), 0600)
			}
		}
		os.Exit(1)
	}
}
