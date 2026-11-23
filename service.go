package main

import (
	"errors"

	"github.com/Sanidhya14321/goh-desktop/internal/desktop"
)

func (s *Service) Versions() (desktop.Versions, error) { return s.host.Versions() }
func (s *Service) RecentProjects() []string            { return s.host.RecentProjects() }

func (s *Service) PickProject() (string, error) {
	dir, err := s.app.Dialog.OpenFile().AttachToWindow(s.window).CanChooseFiles(false).CanChooseDirectories(true).SetTitle("Choose a project folder").PromptForSingleSelection()
	if err != nil || dir == "" {
		return dir, err
	}
	return s.host.SelectProject(dir)
}
func (s *Service) SelectProject(dir string) (string, error)       { return s.host.SelectProject(dir) }
func (s *Service) Sessions(dir string) ([]desktop.Session, error) { return s.host.Sessions(dir) }
func (s *Service) Create(dir string) (desktop.Session, error)     { return s.host.Create(dir) }
func (s *Service) History(session desktop.Session) (desktop.History, error) {
	return s.host.History(session)
}
func (s *Service) Start(session desktop.Session, prompt string, acknowledge bool) error {
	return s.host.Start(session, prompt, acknowledge)
}
func (s *Service) Answer(session desktop.Session, input string, reply desktop.Reply) error {
	return s.host.Answer(session, input, reply)
}
func (s *Service) Cancel(session desktop.Session) error { return s.host.Cancel(session) }

func (s *Service) ProviderStatus() (desktop.ProviderStatus, error) { return s.host.ProviderStatus() }
func (s *Service) SaveProvider(provider desktop.Provider) error    { return s.host.SaveProvider(provider) }
func (s *Service) Login(switchAccount bool) error {
	var openError error
	err := s.host.Login(switchAccount, func(url string) {
		s.app.Event.Emit("provider:auth-url", url)
		openError = s.app.Browser.OpenURL(url)
	})
	if err != nil && openError != nil {
		return errors.Join(err, errors.New("copy the authorization URL if your browser did not open"))
	}
	return err
}
func (s *Service) CancelLogin() { s.host.CancelLogin() }
