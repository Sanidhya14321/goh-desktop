package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"

	"github.com/Sanidhya14321/goh-desktop/internal/desktop"
)

func readPackageInfo(ctx context.Context, exe string) (desktop.Versions, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--package-info")
	configureProbe(cmd)
	data, err := cmd.Output()
	var info desktop.Versions
	if err == nil {
		err = json.Unmarshal(data, &info)
	}
	return info, err
}
