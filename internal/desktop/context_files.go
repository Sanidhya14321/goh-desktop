package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const maxContextFiles = 5

// FileReferences converts native picker results into the engine's quoted
// project-relative references. The engine decides what it can attach at run time.
func FileReferences(project string, paths []string) ([]string, error) {
	if len(paths) > maxContextFiles {
		return nil, fmt.Errorf("choose up to %d files at a time", maxContextFiles)
	}
	root, err := os.OpenRoot(project)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var refs []string
	for _, path := range paths {
		rel, err := filepath.Rel(project, path)
		if err != nil || !filepath.IsLocal(rel) {
			return nil, errors.New("choose files inside this session's project")
		}
		info, err := root.Lstat(rel)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("choose regular files inside this session's project")
		}
		if info.Size() > 64<<10 {
			return nil, fmt.Errorf("%s is larger than GoHarness's 64 KiB attachment limit", filepath.Base(rel))
		}
		ref := "@" + strconv.Quote(filepath.ToSlash(rel))
		if !slices.Contains(refs, ref) {
			refs = append(refs, ref)
		}
	}
	return refs, nil
}

// displayUserContext reads the engine's length-delimited file blocks so the
// conversation can show references without rendering the whole attachment.
func displayUserContext(content string) (string, []string) {
	const prefix = "\n\n<file path="
	const end = "\n</file>"
	search := content
	for len(search) > 0 {
		before, suffix, ok := strings.Cut(search, prefix)
		if !ok {
			break
		}
		start := len(content) - len(search) + len(before)
		paths := []string{}
		for len(paths) < maxContextFiles {
			quoted, err := strconv.QuotedPrefix(suffix)
			if err != nil {
				break
			}
			path, err := strconv.Unquote(quoted)
			fields, ok := strings.CutPrefix(suffix[len(quoted):], " bytes=")
			if !ok {
				break
			}
			delimiter := strings.Index(fields[:min(len(fields), 8)], ">\n")
			if delimiter < 1 {
				break
			}
			size, lengthErr := strconv.Atoi(fields[:delimiter])
			body := fields[delimiter+2:]
			if err != nil || path == "" || lengthErr != nil || size < 0 || size > len(body) || !strings.HasPrefix(body[size:], end) {
				break
			}
			paths = append(paths, path)
			rest := body[size+len(end):]
			if rest == "" {
				return content[:start], paths
			}
			suffix, ok = strings.CutPrefix(rest, prefix)
			if !ok {
				break
			}
		}
		search = content[start+len(prefix):]
	}
	return content, nil
}
