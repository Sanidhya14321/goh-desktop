package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckoutIdentity(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	worktree := filepath.Join(root, "worktree")
	for _, dir := range []string{filepath.Join(repo, ".git"), filepath.Join(repo, "left"), filepath.Join(repo, "right"), filepath.Join(worktree, "left")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: ../repo/.git/worktrees/worktree\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if a, b := checkoutRoot(filepath.Join(repo, "left")), checkoutRoot(filepath.Join(repo, "right")); a != repo || b != repo {
		t.Fatalf("sibling folders must share a checkout, got %q and %q", a, b)
	}
	if got := checkoutRoot(filepath.Join(worktree, "left")); got != worktree {
		t.Fatalf("linked worktree must have a distinct checkout, got %q", got)
	}
}
