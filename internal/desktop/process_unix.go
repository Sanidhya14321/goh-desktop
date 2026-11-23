//go:build !windows

package desktop

import (
	"os/exec"
	"syscall"
)

func launch(cmd *exec.Cmd) (func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }, nil
}

func forceStop(cmd *exec.Cmd) { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }

func hideConsole(_ *exec.Cmd) {}
