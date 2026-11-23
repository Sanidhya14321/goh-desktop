package updates

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

const maxArtifact = 256 << 20

var versionFormat = regexp.MustCompile(`^0\.1\.(0|[1-9][0-9]{0,8})$`)
var engineTag = regexp.MustCompile(`^v1\.(1|[2-9]|[1-9][0-9]+)\.[0-9]+$`)

type Envelope struct {
	Manifest  []byte `json:"manifest"`
	Signature []byte `json:"signature"`
}
type Manifest struct {
	Version   string           `json:"version"`
	Channel   string           `json:"channel"`
	EngineTag string           `json:"engine_tag"`
	Assets    map[string]Asset `json:"assets"`
}
type Asset struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Signature []byte `json:"signature"`
	Size      int64  `json:"size"`
}

type Feed struct {
	URL, Channel string
	Key          ed25519.PublicKey
	Fixture      bool
}

func (f Feed) Name() string { return "GoHarness signed feed" }

func validURL(raw string, fixture bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return fixture && u.Scheme == "http" && ip != nil && ip.IsLoopback()
}

func (f Feed) fetch(ctx context.Context, raw string) (*http.Response, error) {
	if !validURL(raw, f.Fixture) {
		return nil, errors.New("invalid update URL")
	}
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !validURL(next.URL.String(), f.Fixture) {
			return errors.New("invalid update redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("update server returned HTTP %d", res.StatusCode)
	}
	return res, nil
}

func VersionOrdinal(version string) (int, error) {
	if !versionFormat.MatchString(version) {
		return 0, fmt.Errorf("invalid desktop release version %q", version)
	}
	return strconv.Atoi(strings.TrimPrefix(version, "0.1."))
}

// The public preview feed selects a prerelease. Stable builds use only the
// stable release URL. Either endpoint still has to pass the pinned signature.
func (f Feed) manifestURL(ctx context.Context) (string, error) {
	u, err := url.Parse(f.URL)
	if err != nil {
		return "", err
	}
	if f.Channel != "preview" || u.Host != "api.github.com" {
		return f.URL, nil
	}
	res, err := f.fetch(ctx, f.URL)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var releases []struct {
		Tag        string `json:"tag_name"`
		Draft      bool
		Prerelease bool
		Assets     []struct {
			Name string
			URL  string `json:"browser_download_url"`
		}
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&releases); err != nil {
		return "", err
	}
	best := -1
	var manifest string
	for _, release := range releases {
		if release.Draft || !release.Prerelease || !strings.HasPrefix(release.Tag, "v") || !strings.HasSuffix(release.Tag, "-preview") {
			continue
		}
		ordinal, err := VersionOrdinal(strings.TrimSuffix(release.Tag[1:], "-preview"))
		if err != nil || ordinal <= best {
			continue
		}
		for _, asset := range release.Assets {
			if asset.Name == "update.json" {
				best, manifest = ordinal, asset.URL
				break
			}
		}
	}
	if manifest == "" {
		return "", errors.New("no published desktop preview manifest")
	}
	return manifest, nil
}

func (f Feed) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	manifestURL, err := f.manifestURL(ctx)
	if err != nil {
		return nil, err
	}
	res, err := f.fetch(ctx, manifestURL)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 64<<10 {
		return nil, errors.New("update manifest exceeds size limit")
	}
	var envelope Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if len(f.Key) != ed25519.PublicKeySize || !ed25519.Verify(f.Key, envelope.Manifest, envelope.Signature) {
		return nil, errors.New("update manifest signature rejected")
	}
	var m Manifest
	if err := json.Unmarshal(envelope.Manifest, &m); err != nil {
		return nil, err
	}
	if m.Channel != f.Channel || !engineTag.MatchString(m.EngineTag) {
		return nil, errors.New("incompatible update channel or engine tag")
	}
	current, err := VersionOrdinal(req.CurrentVersion)
	if err != nil {
		return nil, err
	}
	next, err := VersionOrdinal(m.Version)
	if err != nil {
		return nil, err
	}
	if next <= current {
		return nil, nil
	}
	target := req.Platform + "-" + req.Arch
	if req.Platform == "darwin" {
		target = "darwin-universal"
	}
	a, ok := m.Assets[target]
	if !ok {
		return nil, errors.New("signed release has no update for this platform")
	}
	if !validURL(a.URL, f.Fixture) || a.Size < 1 || a.Size > maxArtifact {
		return nil, errors.New("invalid update artifact metadata")
	}
	u, _ := url.Parse(a.URL)
	name := path.Base(u.Path)
	want := "goh-desktop-macos-universal-update.zip"
	if req.Platform == "windows" {
		want = "goh-desktop-windows-" + req.Arch + "-update.exe"
	}
	if name != want {
		return nil, errors.New("unexpected whole-install update artifact")
	}
	digest, err := hex.DecodeString(a.SHA256)
	if err != nil || len(digest) != 32 || !ed25519.Verify(f.Key, digest, a.Signature) {
		return nil, errors.New("update payload signature rejected")
	}
	return &updater.Release{Version: m.Version, Channel: m.Channel, Artifact: updater.Artifact{Filename: name, Size: a.Size, Platform: req.Platform, Arch: req.Arch}, Verification: &updater.Verification{DigestAlgo: "sha256", Digest: digest, SignatureAlgo: "ed25519", Signature: a.Signature}, Metadata: map[string]any{"url": a.URL, "engine_tag": m.EngineTag}}, nil
}

func (f Feed) Download(ctx context.Context, rel *updater.Release, dst io.Writer, progress func(int64, int64)) error {
	raw, _ := rel.Metadata["url"].(string)
	res, err := f.fetch(ctx, raw)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	size := rel.Artifact.Size
	n, err := io.Copy(dst, io.LimitReader(res.Body, size+1))
	if err != nil {
		return err
	}
	if n != size {
		return errors.New("update payload size mismatch")
	}
	progress(n, size)
	return nil
}
