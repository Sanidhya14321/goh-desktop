//go:build !windows

package main

import "os/exec"

func configureProbe(_ *exec.Cmd) {}
