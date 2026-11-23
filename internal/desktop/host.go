package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var sessionID = regexp.MustCompile("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")
var stableEngine = regexp.MustCompile(`^1\.(1|[2-9]|[1-9][0-9]+)\.[0-9]+$`)

type Versions struct {
	Desktop string `json:"desktop"`
	Engine  string `json:"engine"`
	Channel string `json:"channel"`
}

type Session struct {
	ID      string `json:"id"`
	Project string `json:"project"`
}

type Frame struct {
	Event   *Event          `json:"event,omitempty"`
	Input   *Input          `json:"input,omitempty"`
	Error   string          `json:"error,omitempty"`
	Pending json.RawMessage `json:"pending,omitempty"`
	End     bool            `json:"end,omitempty"`
}
type Event struct {
	Version   int             `json:"version"`
	SessionID string          `json:"session_id"`
	RunID     string          `json:"run_id"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}
type Input struct {
	ID   string          `json:"id"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}
type Reply struct {
	Allow   *bool      `json:"allow,omitempty"`
	Answers [][]string `json:"answers,omitempty"`
	Dismiss bool       `json:"dismiss,omitempty"`
}

type slot struct {
	ready chan struct{}
	*helper
	err error
}

type run struct {
	checkout string
	cancel   context.CancelFunc
	engine   *helper
	id       string
	pending  string
}

type Host struct {
	root, sessions, binary string
	versions               Versions
	expected               string
	development            bool
	emit                   func(string, []Frame)
	ctx                    context.Context
	shutdown               context.CancelFunc

	mu                                   sync.Mutex
	projects                             []string
	helpers                              map[string]*slot
	runs                                 map[Session]*run
	closed, restarting, changingProvider bool
	operations                           int
	authCancel                           context.CancelFunc
	wg                                   sync.WaitGroup
}

func New(root, binary string, versions Versions, expected string, development bool, emit func(string, []Frame)) (*Host, error) {
	if !filepath.IsAbs(binary) || !filepath.IsAbs(root) {
		return nil, errors.New("desktop paths must be absolute")
	}
	sessions, err := ensureDirectory(filepath.Join(root, "sessions"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &Host{root: root, sessions: sessions, binary: binary, versions: versions, expected: expected, development: development, emit: emit, ctx: ctx, shutdown: cancel, helpers: make(map[string]*slot), runs: make(map[Session]*run)}
	data, err := os.ReadFile(filepath.Join(root, "projects.json"))
	if err == nil {
		err = json.Unmarshal(data, &h.projects)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, fmt.Errorf("read recent projects: %w", err)
	}
	return h, nil
}

func ensureDirectory(path string) (string, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}

func (h *Host) Versions() (Versions, error) {
	h.mu.Lock()
	versions := h.versions
	h.mu.Unlock()
	if versions.Engine != "" {
		return versions, nil
	}
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.binary, "version")
	cmd.Dir = h.root
	cmd.Env = processEnv()
	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return versions, fmt.Errorf("cannot run the bundled GoHarness engine: %w", err)
	}
	versions.Engine = strings.TrimSpace(string(out))
	if (!stableEngine.MatchString(versions.Engine) && !h.development) || (h.expected != "" && versions.Engine != h.expected) {
		return versions, fmt.Errorf("unsupported GoHarness engine %q (expected %s with API v1)", versions.Engine, h.expected)
	}
	h.mu.Lock()
	h.versions = versions
	h.mu.Unlock()
	return versions, nil
}

func (h *Host) RecentProjects() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string{}, h.projects...)
}

func canonical(project string) (string, error) {
	if !filepath.IsAbs(project) {
		return "", errors.New("select an absolute project folder")
	}
	dir, err := filepath.EvalSymlinks(filepath.Clean(project))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("select a project folder")
	}
	return dir, nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	if a == b {
		return true
	}
	ai, aerr := os.Stat(a)
	bi, berr := os.Stat(b)
	return aerr == nil && berr == nil && os.SameFile(ai, bi)
}

// A .git file also marks a linked worktree or submodule. Use its working
// directory as the identity, since separate worktrees have separate writers.
func checkoutRoot(project string) string {
	for dir := project; ; dir = filepath.Dir(dir) {
		if info, err := os.Lstat(filepath.Join(dir, ".git")); err == nil &&
			(info.IsDir() || info.Mode().IsRegular()) {
			return dir
		}
		if filepath.Dir(dir) == dir {
			return project
		}
	}
}

func overlaps(a, b string) bool {
	if samePath(a, b) {
		return true
	}
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		rel, err := filepath.Rel(pair[0], pair[1])
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func (h *Host) SelectProject(project string) (string, error) {
	dir, err := canonical(project)
	if err != nil {
		return "", err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	next := []string{dir}
	for _, path := range h.projects {
		if samePath(dir, path) {
			continue
		}
		next = append(next, path)
		if len(next) == 25 {
			break
		}
	}
	if err := writeJSON(h.root, "projects.json", next); err != nil {
		return "", err
	}
	h.projects = next
	return dir, nil
}

func writeJSON(dir, name string, value any) error {
	return writePrivate(dir, name, func(w io.Writer) error { return json.NewEncoder(w).Encode(value) })
}

func writePrivate(dir, name string, write func(io.Writer) error) error {
	tmp, err := os.CreateTemp(dir, ".new-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	err = write(tmp)
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

func (h *Host) acquire(project string) (*helper, func(), error) {
	if _, err := h.Versions(); err != nil {
		return nil, nil, err
	}
	h.mu.Lock()
	if h.closed || h.restarting || h.changingProvider {
		h.mu.Unlock()
		return nil, nil, errors.New("desktop is closing or changing settings")
	}
	var current *slot
	for path, s := range h.helpers {
		if samePath(path, project) {
			current = s
			project = path
			break
		}
	}
	if current == nil {
		if len(h.helpers) == 2 {
			for path, s := range h.helpers {
				if s.helper != nil && s.users == 0 {
					h.removeHelperLocked(path, s)
					break
				}
			}
		}
		if len(h.helpers) == 2 {
			h.mu.Unlock()
			return nil, nil, errors.New("both engine slots are in use")
		}
		current = &slot{ready: make(chan struct{})}
		h.helpers[project] = current
		h.wg.Add(1)
		h.operations++
		h.mu.Unlock()
		config, env, err := h.engineConfig()
		var engine *helper
		if err == nil {
			engine, err = startHelper(h.ctx, h.binary, project, h.sessions, config, env)
		}
		h.mu.Lock()
		if err == nil && h.closed {
			engine.stop()
			engine = nil
			err = context.Canceled
		}
		current.helper, current.err = engine, err
		if err != nil {
			delete(h.helpers, project)
		}
		close(current.ready)
		h.operations--
		h.wg.Done()
	} else {
		h.mu.Unlock()
		<-current.ready
		h.mu.Lock()
	}
	defer h.mu.Unlock()
	if current.err != nil {
		return nil, nil, current.err
	}
	if h.helpers[project] != current || h.closed || h.restarting || h.changingProvider {
		return nil, nil, errors.New("GoHarness stopped; retry the operation")
	}
	select {
	case <-current.done:
		h.removeHelperLocked(project, current)
		return nil, nil, errors.New("GoHarness stopped unexpectedly; retry the operation")
	default:
	}
	if current.timer != nil {
		current.timer.Stop()
		current.timer = nil
	}
	current.users++
	h.wg.Add(1)
	return current.helper, func() {
		h.mu.Lock()
		current.users--
		if current.users == 0 && h.helpers[project] == current && !h.closed && !h.restarting && !h.changingProvider {
			var timer *time.Timer
			timer = time.AfterFunc(idleTimeout, func() {
				h.mu.Lock()
				defer h.mu.Unlock()
				if h.helpers[project] == current && current.users == 0 && current.timer == timer {
					h.removeHelperLocked(project, current)
				}
			})
			current.timer = timer
		}
		h.mu.Unlock()
		h.wg.Done()
	}, nil
}

func (h *Host) removeHelperLocked(project string, current *slot) {
	if current.timer != nil {
		current.timer.Stop()
	}
	current.stop()
	delete(h.helpers, project)
}

func (h *Host) Create(project string) (Session, error) {
	project, err := canonical(project)
	if err != nil {
		return Session{}, err
	}
	engine, release, err := h.acquire(project)
	if err != nil {
		return Session{}, err
	}
	defer release()
	var session Session
	err = engine.json(h.ctx, http.MethodPost, "/v1/sessions", nil, &session)
	if err == nil && (!sessionID.MatchString(session.ID) || !samePath(session.Project, project)) {
		err = errors.New("invalid GoHarness session identity")
	}
	return session, err
}

func (h *Host) Start(session Session, prompt string, acknowledge bool) error {
	if !sessionID.MatchString(session.ID) {
		return errors.New("invalid session ID")
	}
	project, err := canonical(session.Project)
	if err != nil {
		return err
	}
	if !samePath(project, session.Project) {
		return errors.New("project path changed; reopen the session")
	}
	if strings.TrimSpace(prompt) == "" || len(prompt) > 64<<10 {
		return errors.New("enter a prompt of up to 64 KiB")
	}
	checkout := checkoutRoot(project)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.restarting || h.changingProvider {
		return errors.New("desktop is closing or changing settings")
	}
	if len(h.runs) >= 2 {
		return errors.New("both run slots are in use")
	}
	for other, running := range h.runs {
		if overlaps(project, other.Project) || samePath(checkout, running.checkout) {
			return errors.New("another session is running in this checkout")
		}
	}
	ctx, cancel := context.WithCancel(h.ctx)
	active := &run{cancel: cancel, checkout: checkout}
	h.runs[session] = active
	h.wg.Add(1)
	go h.stream(ctx, session, active, prompt, acknowledge)
	return nil
}

func (h *Host) stream(ctx context.Context, session Session, active *run, prompt string, acknowledge bool) {
	defer h.wg.Done()
	defer active.cancel()
	finished := Frame{End: true}
	defer func() {
		h.mu.Lock()
		delete(h.runs, session)
		h.mu.Unlock()
		h.emit(session.ID, []Frame{finished})
	}()
	fail := func(err error) {
		if errors.Is(ctx.Err(), context.Canceled) {
			finished.Error = "Cancelled"
			return
		}
		finished.Error = err.Error()
		var api *apiError
		if errors.As(err, &api) && len(api.pending) > 0 {
			finished.Pending = api.pending
		}
	}
	engine, release, err := h.acquire(session.Project)
	if err != nil {
		fail(err)
		return
	}
	defer release()
	h.mu.Lock()
	active.engine = engine
	h.mu.Unlock()
	response, err := engine.request(ctx, http.MethodPost, "/v1/sessions/"+session.ID+"/run", map[string]any{"prompt": prompt, "acknowledge_uncertain": acknowledge})
	if err != nil {
		fail(err)
		return
	}
	defer response.Body.Close()
	id := response.Header.Get("X-Harness-Run-ID")
	if !sessionID.MatchString(id) || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/x-ndjson") {
		fail(errors.New("incompatible GoHarness stream"))
		return
	}
	h.mu.Lock()
	active.id = id
	h.mu.Unlock()

	incoming := make(chan Frame, 64)
	readError := make(chan error, 1)
	go func() {
		defer close(incoming)
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 32<<10), 16<<20)
		for scanner.Scan() {
			var frame Frame
			if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
				readError <- err
				return
			}
			if frame.Event != nil && (frame.Event.Version != 1 || frame.Event.SessionID != session.ID || frame.Event.RunID != id) {
				readError <- errors.New("incompatible GoHarness event")
				return
			}
			if frame.Event != nil && !displayEvent(frame.Event) {
				continue
			}
			if frame.Input != nil && frame.Input.Kind == "permission" {
				var preview struct {
					Tool    string `json:"tool"`
					Preview string `json:"preview"`
				}
				if err := json.Unmarshal(frame.Input.Data, &preview); err != nil {
					readError <- errors.New("invalid GoHarness permission preview")
					return
				}
				preview.Preview = clip(preview.Preview, 32<<10)
				frame.Input.Data, _ = json.Marshal(preview)
			}
			select {
			case incoming <- frame:
			case <-ctx.Done():
				readError <- ctx.Err()
				return
			}
		}
		readError <- scanner.Err()
	}()
	var batch []Frame
	var timer *time.Timer
	var tick <-chan time.Time
	flush := func() {
		if len(batch) > 0 {
			h.emit(session.ID, batch)
			batch = nil
		}
		if timer != nil {
			timer.Stop()
			timer = nil
			tick = nil
		}
	}
	defer flush()
	ended := false
	for {
		select {
		case frame, ok := <-incoming:
			if !ok {
				if err := <-readError; err != nil {
					fail(err)
				} else if !ended {
					fail(errors.New("connection closed before GoHarness finished the run"))
				}
				return
			}
			if frame.Event != nil {
				ended = ended || frame.Event.Type == "run_finished"
			}
			if frame.Input != nil {
				if !sessionID.MatchString(frame.Input.ID) {
					fail(errors.New("invalid GoHarness challenge"))
					return
				}
				h.mu.Lock()
				active.pending = frame.Input.ID
				h.mu.Unlock()
			}
			batch = append(batch, frame)
			if len(batch) >= 24 || frame.Input != nil {
				flush()
			} else if timer == nil {
				timer = time.NewTimer(35 * time.Millisecond)
				tick = timer.C
			}
		case <-tick:
			flush()
		case <-ctx.Done():
			fail(ctx.Err())
			return
		}
	}
}

func (h *Host) Answer(session Session, input string, reply Reply) error {
	h.mu.Lock()
	active := h.runs[session]
	if active == nil || active.id == "" || active.pending != input || !sessionID.MatchString(input) {
		h.mu.Unlock()
		return errors.New("input is no longer pending for this session")
	}
	engine, id := active.engine, active.id
	h.mu.Unlock()
	if err := engine.json(h.ctx, http.MethodPost, "/v1/runs/"+id+"/inputs/"+input, reply, nil); err != nil {
		return err
	}
	h.mu.Lock()
	if active.pending == input {
		active.pending = ""
	}
	h.mu.Unlock()
	return nil
}

func (h *Host) Cancel(session Session) error {
	h.mu.Lock()
	active := h.runs[session]
	if active == nil {
		h.mu.Unlock()
		return nil
	}
	engine, id := active.engine, active.id
	h.mu.Unlock()
	if id == "" {
		active.cancel()
		return nil
	}
	err := engine.json(h.ctx, http.MethodPost, "/v1/runs/"+id+"/cancel", nil, nil)
	var api *apiError
	if errors.As(err, &api) && api.status == http.StatusNotFound {
		return nil
	}
	return err
}

func (h *Host) BeforeRestart() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.restarting || h.changingProvider || len(h.runs) != 0 || h.operations != 0 {
		return errors.New("wait for active sessions and provider setup to finish before restarting")
	}
	for _, s := range h.helpers {
		if s.users > 0 {
			return errors.New("wait for GoHarness to finish its current operation")
		}
	}
	h.restarting = true
	for path, s := range h.helpers {
		h.removeHelperLocked(path, s)
	}
	return nil
}

func (h *Host) ResumeAfterFailedRestart() {
	h.mu.Lock()
	h.restarting = false
	h.mu.Unlock()
}

func (h *Host) Close() {
	h.mu.Lock()
	h.closed = true
	h.shutdown()
	h.mu.Unlock()
	h.wg.Wait()
	h.mu.Lock()
	defer h.mu.Unlock()
	for path, s := range h.helpers {
		h.removeHelperLocked(path, s)
	}
}
