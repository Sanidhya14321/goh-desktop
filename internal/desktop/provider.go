package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const providerKeyEnv = "GOH_DESKTOP_PROVIDER_KEY"

type Provider struct {
	Protocol      string `json:"protocol"`
	BaseURL       string `json:"base_url,omitempty"`
	Model         string `json:"model"`
	Key           string `json:"key,omitempty"`
	ContextWindow int    `json:"context_window,omitempty"`
}

type ProviderStatus struct {
	Source   string `json:"source"`
	Protocol string `json:"protocol"`
	Model    string `json:"model"`
}

func (h *Host) readProvider() (Provider, error) {
	var p Provider
	raw, err := os.ReadFile(filepath.Join(h.root, "provider.json"))
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &p)
	}
	return p, err
}

func (h *Host) engineConfig() (string, []string, error) {
	env := processEnv()
	p, err := h.readProvider()
	if err != nil || p.Protocol == "" {
		return "", env, err
	}
	window := p.ContextWindow
	if window == 0 {
		window = 32768
	}
	config := map[string]any{"protocol": p.Protocol, "model": p.Model, "context_window": window}
	if p.BaseURL != "" {
		config["base_url"] = p.BaseURL
	}
	if p.Key != "" {
		config["api_key_env"] = providerKeyEnv
		env = append(env, providerKeyEnv+"="+p.Key)
	}
	filtered := env[:0]
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "HARNESS_PROFILE", "HARNESS_MODEL", "HARNESS_PROTOCOL", "HARNESS_ENDPOINT", "HARNESS_BASE_URL", "HARNESS_API_KEY_ENV", "HARNESS_CONTEXT_WINDOW":
		default:
			filtered = append(filtered, entry)
		}
	}
	if err := writeJSON(h.root, "engine-config.json", config); err != nil {
		return "", nil, err
	}
	return filepath.Join(h.root, "engine-config.json"), filtered, nil
}

func (h *Host) ProviderStatus() (ProviderStatus, error) {
	p, err := h.readProvider()
	if err != nil {
		return ProviderStatus{}, err
	}
	if p.Protocol != "" {
		return ProviderStatus{Source: "Desktop", Protocol: p.Protocol, Model: p.Model}, nil
	}
	if _, err := h.Versions(); err != nil {
		return ProviderStatus{}, err
	}
	ctx, cancel := context.WithTimeout(h.ctx, 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.binary, "config")
	cmd.Dir = h.root
	cmd.Env = processEnv()
	hideConsole(cmd)
	raw, err := cmd.Output()
	if err != nil {
		return ProviderStatus{}, fmt.Errorf("could not read existing GoHarness settings (goh config): %w", err)
	}
	var cfg struct {
		Protocol string
		Model    string
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ProviderStatus{}, err
	}
	return ProviderStatus{Source: "GoHarness settings", Protocol: cfg.Protocol, Model: cfg.Model}, nil
}

func (h *Host) changeProvider() (func(), error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.restarting || h.changingProvider || len(h.runs) != 0 || h.operations > 0 {
		return nil, errors.New("finish active sessions and provider setup before changing provider")
	}
	for _, s := range h.helpers {
		if s.users > 0 {
			return nil, errors.New("wait for GoHarness to finish its current operation")
		}
	}
	h.changingProvider = true
	h.wg.Add(1)
	for path, s := range h.helpers {
		h.removeHelperLocked(path, s)
	}
	return func() {
		h.mu.Lock()
		h.changingProvider = false
		h.authCancel = nil
		h.mu.Unlock()
		h.wg.Done()
	}, nil
}

func (h *Host) SaveProvider(p Provider) error {
	finish, err := h.changeProvider()
	if err != nil {
		return err
	}
	defer finish()
	if p.Protocol == "" {
		err := os.Remove(filepath.Join(h.root, "provider.json"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	switch p.Protocol {
	case "chat_completions", "openai_responses", "anthropic_messages":
	default:
		return errors.New("choose a supported provider protocol")
	}
	p.Model, p.BaseURL = strings.TrimSpace(p.Model), strings.TrimSpace(p.BaseURL)
	if p.Model == "" || len(p.Model) > 256 || strings.ContainsAny(p.Model, "\r\n\x00") {
		return errors.New("enter the model ID supplied by your provider")
	}
	address, err := url.Parse(p.BaseURL)
	if err != nil || address.Hostname() == "" || address.User != nil || address.RawQuery != "" || address.Fragment != "" {
		return errors.New("enter a provider URL without credentials, query, or fragment")
	}
	ip := net.ParseIP(address.Hostname())
	if address.Scheme != "https" && !(address.Scheme == "http" && ((ip != nil && ip.IsLoopback()) || address.Hostname() == "localhost")) {
		return errors.New("use HTTPS for remote providers or HTTP on loopback")
	}
	if p.ContextWindow < 0 || p.ContextWindow > 10000000 {
		return errors.New("enter a context window between 1 and 10000000 tokens")
	}
	if len(p.Key) > 16384 || strings.ContainsAny(p.Key, "\r\n\x00") {
		return errors.New("invalid API key")
	}
	return writeJSON(h.root, "provider.json", p)
}

// Login forwards only the public authorization URL to the native browser.
func (h *Host) Login(switchAccount bool, open func(string)) error {
	if _, err := h.Versions(); err != nil {
		return err
	}
	finish, err := h.changeProvider()
	if err != nil {
		return err
	}
	defer finish()
	ctx, cancel := context.WithTimeout(h.ctx, 4*time.Minute+5*time.Second)
	defer cancel()
	h.mu.Lock()
	h.authCancel = cancel
	h.mu.Unlock()
	operation := "login"
	if switchAccount {
		operation = "switch"
	}
	cmd := exec.Command(h.binary, "auth", operation)
	cmd.Dir = h.root
	cmd.Env = append(processEnv(), "GOH_NO_BROWSER=1")
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	diagnostics := new(tail)
	cmd.Stderr = diagnostics
	stop, err := launch(cmd)
	if err != nil {
		return err
	}
	stop = sync.OnceFunc(stop)
	defer stop()
	done := make(chan error, 1)
	model := ""
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			line := scanner.Text()
			if address, e := url.Parse(line); e == nil && address.Scheme == "https" && address.Host == "auth.openai.com" && address.User == nil && address.Path == "/api/accounts/authorize" {
				open(line)
			}
			if m, ok := strings.CutPrefix(line, "Default model: "); ok {
				model = m
			}
		}
		done <- cmd.Wait()
	}()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("ChatGPT sign-in failed. %s Use Switch account if the browser is signed into another workspace", diagnostics.String())
		}
	case <-ctx.Done():
		stop()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			forceStop(cmd)
			<-done
		}
		return errors.New("ChatGPT sign-in ended before authorization. Retry from the provider panel")
	}
	if model == "" {
		return errors.New("ChatGPT authorization did not report a default model. Try switching accounts")
	}
	return writeJSON(h.root, "provider.json", Provider{Protocol: "openai_chatgpt", Model: model})
}

func (h *Host) CancelLogin() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.authCancel != nil {
		h.authCancel()
	}
}
