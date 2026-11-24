package desktop

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const idleTimeout = 15 * time.Second

type tail struct {
	sync.Mutex
	data []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.Lock()
	defer t.Unlock()
	t.data = append(t.data, p...)
	if len(t.data) > 8192 {
		t.data = append([]byte(nil), t.data[len(t.data)-8192:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.Lock()
	defer t.Unlock()
	return strings.TrimSpace(string(t.data))
}

type helper struct {
	endpoint, token string
	client          *http.Client
	transport       *http.Transport
	done            chan struct{}
	stop            func()
	timer           *time.Timer
	users           int
}

type engineInfo struct {
	Project    string `json:"project"`
	SessionDir string `json:"session_dir"`
	Model      string `json:"model"`
	Protocol   string `json:"protocol"`
	Agent      string `json:"agent"`
}

func startHelper(ctx context.Context, binary, project, sessions, config string, env []string, mode RunMode) (*helper, error) {
	token := hex.EncodeToString(randBytes(32))
	args := []string{"serve", "--listen", "127.0.0.1:0", "--project", project, "--session-dir", sessions}
	if config != "" {
		args = append(args, "--config", config)
	}
	if mode != ModeDefault {
		args = append(args, "--agent", string(mode))
	}
	cmd := exec.Command(binary, args...)
	// Keep the helper's initial working directory out of untrusted projects.
	cmd.Dir = sessions
	cmd.Env = append(env, "HARNESS_SERVER_TOKEN="+token)
	diagnostics := new(tail)
	announced := make(chan string, 1)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = io.Discard
	stop, err := launch(cmd)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, ResponseHeaderTimeout: 10 * time.Second, MaxIdleConnsPerHost: 2}
	h := &helper{token: token, transport: transport, client: &http.Client{Transport: transport, CheckRedirect: noRedirect}, done: make(chan struct{})}
	h.stop = sync.OnceFunc(func() {
		stop()
		select {
		case <-h.done:
		case <-time.After(3 * time.Second):
			forceStop(cmd)
			<-h.done
		}
		transport.CloseIdleConnections()
	})
	go func() {
		reader := bufio.NewReaderSize(stderr, 4096)
		for {
			line, err := reader.ReadSlice('\n')
			_, _ = diagnostics.Write(line)
			if value, ok := strings.CutPrefix(strings.TrimSpace(string(line)), "Harness API listening on "); ok {
				host, port, e := net.SplitHostPort(value)
				n, nerr := strconv.Atoi(port)
				if e == nil && nerr == nil && host == "127.0.0.1" && n > 0 && n <= 65535 {
					select {
					case announced <- value:
					default:
					}
				}
			}
			if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
				break
			}
		}
		_ = cmd.Wait()
		close(h.done)
	}()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	select {
	case address := <-announced:
		h.endpoint = "http://" + address
	case <-h.done:
		h.stop()
		return nil, fmt.Errorf("GoHarness exited during startup. Check provider settings. %s", strings.ReplaceAll(diagnostics.String(), token, "[redacted]"))
	case <-startup.Done():
		h.stop()
		return nil, fmt.Errorf("waiting for GoHarness: %w", startup.Err())
	}
	var info engineInfo
	if err := h.json(startup, http.MethodGet, "/v1/info", nil, &info); err != nil {
		h.stop()
		return nil, fmt.Errorf("GoHarness API compatibility check: %w", err)
	}
	if !samePath(info.Project, project) || !samePath(info.SessionDir, sessions) || info.Protocol == "" {
		h.stop()
		return nil, errors.New("GoHarness returned incompatible v1 project information")
	}
	if mode != ModeDefault && info.Agent != string(mode) {
		h.stop()
		return nil, errors.New("GoHarness did not select the requested agent")
	}
	return h, nil
}

func randBytes(n int) []byte {
	data := make([]byte, n)
	rand.Read(data)
	return data
}

func noRedirect(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }

func (h *helper) request(ctx context.Context, method, path string, value any) (*http.Response, error) {
	var body io.Reader
	if value != nil {
		data, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.endpoint+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		defer res.Body.Close()
		var problem struct {
			Error   string
			Pending json.RawMessage
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&problem)
		return nil, &apiError{status: res.StatusCode, message: strings.ReplaceAll(problem.Error, h.token, "[redacted]"), pending: problem.Pending}
	}
	return res, nil
}

type apiError struct {
	status  int
	message string
	pending json.RawMessage
}

func (e *apiError) Error() string { return fmt.Sprintf("GoHarness API (%d): %s", e.status, e.message) }

func (h *helper) json(ctx context.Context, method, path string, value, out any) error {
	bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := h.request(bounded, method, path, value)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil {
		_, err = io.Copy(io.Discard, res.Body)
		return err
	}
	return json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(out)
}

func processEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "HARNESS_SERVER_TOKEN") && !strings.EqualFold(key, providerKeyEnv) {
			env = append(env, entry)
		}
	}
	return env
}
