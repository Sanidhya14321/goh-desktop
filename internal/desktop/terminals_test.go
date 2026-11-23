package desktop

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTerminalRunsInProjectAndCloses(t *testing.T) {
	if testing.Short() {
		t.Skip("requires the platform PTY")
	}
	output := make(chan TerminalPacket, 128)
	manager := NewTerminals(func(p TerminalPacket) { output <- p })
	t.Cleanup(manager.Shutdown)
	project, err := canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	shell, cwd := "sh", "pwd"
	if runtime.GOOS == "windows" {
		shell, cwd = "cmd", "cd"
	}
	const ID = "test-terminal"
	if _, err := manager.Start(ID, project, shell, 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := manager.BeforeRestart(); err == nil {
		t.Fatal("restart should reject a live shell")
	}
	if err := manager.Resize(ID, 100, 30); err != nil {
		t.Fatal(err)
	}
	if err := manager.Write(ID, cwd+"\r"); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(10 * time.Second)
	var log strings.Builder
	for {
		select {
		case packet := <-output:
			if packet.Exit != nil {
				t.Fatalf("shell exited before showing project: %s", log.String())
			}
			log.Write(packet.Data)
			if strings.Contains(log.String(), project) {
				if err := manager.Close(ID); err != nil {
					t.Fatal(err)
				}
				if err := manager.BeforeRestart(); err != nil {
					t.Fatal(err)
				}
				return
			}
		case <-timeout:
			t.Fatalf("shell never printed the project directory: %s", log.String())
		}
	}
}
