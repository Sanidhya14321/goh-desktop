package desktop

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

type journalRecord struct {
	Type string
	Data json.RawMessage
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type History struct {
	Messages  []Message `json:"messages"`
	Truncated bool      `json:"truncated"`
}

func openJournal(root *os.Root, id string) (*os.File, *bufio.Reader, Session, error) {
	var header Session
	if !sessionID.MatchString(id) {
		return nil, nil, header, errors.New("invalid session ID")
	}
	name := id + ".jsonl"
	if info, err := root.Lstat(name); err != nil || !info.Mode().IsRegular() {
		return nil, nil, header, errors.New("session journal is unavailable")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, header, err
	}
	reader := bufio.NewReaderSize(file, 16<<10)
	info, err := file.Stat()
	if err == nil && info.Mode().IsRegular() {
		line, e := reader.ReadSlice('\n')
		var record journalRecord
		if e == nil && json.Unmarshal(line, &record) == nil && record.Type == "session_start" && json.Unmarshal(record.Data, &header) == nil && header.ID == id {
			return file, reader, header, nil
		}
	}
	file.Close()
	return nil, nil, header, errors.New("invalid session journal header")
}

func (h *Host) Sessions(project string) ([]Session, error) {
	project, err := canonical(project)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(h.sessions)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	entries, err := os.ReadDir(h.sessions)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id       string
		modified time.Time
	}
	journals := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".jsonl")
		if !ok || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err == nil {
			journals = append(journals, candidate{id, info.ModTime()})
		}
	}
	sort.Slice(journals, func(i, j int) bool {
		if journals[i].modified.Equal(journals[j].modified) {
			return journals[i].id > journals[j].id
		}
		return journals[i].modified.After(journals[j].modified)
	})
	sessions := []Session{}
	for _, journal := range journals {
		file, _, header, err := openJournal(root, journal.id)
		if err != nil {
			continue
		}
		file.Close()
		if samePath(header.Project, project) {
			sessions = append(sessions, header)
		}
		if len(sessions) == 100 {
			break
		}
	}
	return sessions, nil
}

func (h *Host) History(session Session) (History, error) {
	history := History{Messages: []Message{}}
	root, err := os.OpenRoot(h.sessions)
	if err != nil {
		return history, err
	}
	defer root.Close()
	file, reader, header, err := openJournal(root, session.ID)
	if err != nil {
		return history, err
	}
	defer file.Close()
	if !samePath(header.Project, session.Project) {
		return history, errors.New("session belongs to another project")
	}
	info, err := file.Stat()
	if err != nil {
		return history, err
	}
	const budget = 2 << 20
	if info.Size() > budget {
		if _, err := file.Seek(info.Size()-budget, io.SeekStart); err != nil {
			return history, err
		}
		reader.Reset(file)
		for {
			_, err := reader.ReadSlice('\n')
			if !errors.Is(err, bufio.ErrBufferFull) {
				break
			}
		}
		history.Truncated = true
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, budget))
	scanner.Buffer(make([]byte, 16<<10), budget+1)
	for scanner.Scan() {
		var record journalRecord
		if json.Unmarshal(scanner.Bytes(), &record) != nil || record.Type != "message" {
			continue
		}
		var msg Message
		if json.Unmarshal(record.Data, &msg) != nil || (msg.Role != "user" && msg.Role != "assistant" && msg.Role != "tool") || msg.Content == "" {
			continue
		}
		msg.Content = clip(msg.Content, 8192)
		history.Messages = append(history.Messages, msg)
		if len(history.Messages) > 150 {
			history.Messages = history.Messages[1:]
			history.Truncated = true
		}
	}
	return history, scanner.Err()
}

func clip(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return strings.ToValidUTF8(value[:n], "") + "\n…"
}
