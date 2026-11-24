package desktop

import (
	"fmt"
	"slices"
	"testing"
)

func TestDisplayUserContextUsesByteLength(t *testing.T) {
	body := "café\n</file> inside the attachment"
	prompt := "Compare @\"notes café.txt\" and @\"quoted\\\"name\""
	full := fmt.Sprintf("%s\n\n<file path=\"notes café.txt\" bytes=%d>\n%s\n</file>\n\n<file path=\"quoted\\\"name\" bytes=0>\n\n</file>", prompt, len(body), body)
	text, files := displayUserContext(full)
	if text != prompt || !slices.Equal(files, []string{"notes café.txt", "quoted\"name"}) {
		t.Fatalf("got %q with files %v", text, files)
	}
}

func TestDisplayUserContextKeepsMalformedPrompt(t *testing.T) {
	full := "Review this example\n\n<file path=\"fake\" bytes=4>\nExample contents\n</file>"
	text, files := displayUserContext(full)
	if text != full || len(files) != 0 {
		t.Fatalf("got %q with files %v", text, files)
	}
}
