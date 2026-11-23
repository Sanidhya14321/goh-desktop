package updates

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

func TestFeedRejectsManifestMutationAndRollback(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var result atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(result.Load().([]byte)) }))
	defer server.Close()
	digest := sha256.Sum256([]byte("complete app"))
	m := Manifest{
		Version: "0.1.12", Channel: "stable", EngineTag: "v1.1.0",
		Assets: map[string]Asset{"darwin-universal": {
			URL:    server.URL + "/goh-desktop-macos-universal-update.zip",
			SHA256: hex.EncodeToString(digest[:]), Signature: ed25519.Sign(private, digest[:]), Size: 12,
		}},
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	envelope := Envelope{Manifest: raw, Signature: ed25519.Sign(private, raw)}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	result.Store(encoded)
	feed := Feed{URL: server.URL, Channel: "stable", Key: public, Fixture: true}
	request := updater.CheckRequest{CurrentVersion: "0.1.9", Platform: "darwin", Arch: "arm64"}
	release, err := feed.Check(context.Background(), request)
	if err != nil || release == nil || release.Version != m.Version {
		t.Fatalf("authenticated release failed: %v, %v", release, err)
	}
	request.CurrentVersion = "0.1.13"
	if release, err := feed.Check(context.Background(), request); err != nil || release != nil {
		t.Fatalf("rollback should return no release: %v, %v", release, err)
	}
	envelope.Manifest = []byte(strings.Replace(string(raw), "0.1.12", "0.1.99", 1))
	encoded, err = json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	result.Store(encoded)
	if _, err := feed.Check(context.Background(), request); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("mutated manifest should fail signature validation: %v", err)
	}
}
