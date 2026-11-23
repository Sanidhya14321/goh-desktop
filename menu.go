package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (s *Service) configureMenu() {
	menu := s.app.NewMenu()
	command := func(target *application.Menu, label, event string) {
		target.Add(label).OnClick(func(_ *application.Context) { s.app.Event.Emit("workspace:command", event) })
	}
	if runtime.GOOS == "darwin" {
		app := menu.AddSubmenu(appName())
		command(app, "Settings…", "settings")
		app.AddSeparator()
		app.AddRole(application.Hide)
		app.AddRole(application.HideOthers)
		app.AddRole(application.Quit)
	}
	file := menu.AddSubmenu("File")
	command(file, "Open Project…", "open")
	command(file, "New Session", "session")
	command(file, "New Terminal", "terminal")
	if runtime.GOOS != "darwin" {
		file.AddSeparator()
		command(file, "Settings…", "settings")
		file.AddRole(application.Quit)
	}
	menu.AddRole(application.EditMenu)
	view := menu.AddSubmenu("View")
	command(view, "Command Palette…", "palette")
	command(view, "Toggle Sidebar", "sidebar")
	command(view, "Toggle Terminal", "dock")
	command(view, "Toggle Agent Activity", "activity")
	view.AddSeparator()
	view.AddRole(application.ZoomIn)
	view.AddRole(application.ZoomOut)
	view.AddRole(application.ResetZoom)
	if runtime.GOOS == "darwin" {
		menu.AddRole(application.WindowMenu)
	}
	s.app.Menu.SetApplicationMenu(menu)
}
