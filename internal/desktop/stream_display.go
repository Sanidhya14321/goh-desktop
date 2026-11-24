package desktop

import "encoding/json"

// The engine journal retains the original records. Keep the UI transport
// bounded and send only the fields consumed by the session view.
func displayEvent(event *Event) bool {
	switch event.Type {
	case "run_started":
		var context RunContext
		_ = json.Unmarshal(event.Data, &context)
		event.Data, _ = json.Marshal(context)
		return true
	case "run_finished":
		var result RunSummary
		if err := json.Unmarshal(event.Data, &result); err != nil {
			return false
		}
		result.ID = event.RunID
		result.limitDisplay()
		event.Data, _ = json.Marshal(result)
		return true
	case "files_attached":
		var data struct {
			Paths []string `json:"paths"`
		}
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return false
		}
		data.Paths = data.Paths[:min(len(data.Paths), maxContextFiles)]
		for i, path := range data.Paths {
			data.Paths[i] = clip(path, 4096)
		}
		event.Data, _ = json.Marshal(data)
		return true
	case "assistant_started", "assistant_reset", "permission_resolved":
		event.Data = nil
		return true
	case "assistant_updated", "assistant_completed", "tool_progress", "tool_started", "tool_updated", "tool_finished", "subagent_started", "subagent_finished", "subagent_event", "error":
	default:
		return false
	}
	var data struct {
		Text    string          `json:"text,omitempty"`
		ID      string          `json:"id,omitempty"`
		Name    string          `json:"name,omitempty"`
		TaskID  string          `json:"task_id,omitempty"`
		Agent   string          `json:"agent,omitempty"`
		Tool    string          `json:"tool,omitempty"`
		Target  string          `json:"target,omitempty"`
		Status  string          `json:"status,omitempty"`
		Message json.RawMessage `json:"message,omitempty"`
		Result  *struct {
			Content string `json:"content"`
			Error   bool   `json:"error,omitempty"`
		} `json:"result,omitempty"`
		Event *Event `json:"event,omitempty"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return false
	}
	data.Text = clip(data.Text, 8192)
	data.Target = clip(data.Target, 512)
	if data.Result != nil {
		data.Result.Content = clip(data.Result.Content, 8192)
	}
	if data.Message != nil {
		switch event.Type {
		case "assistant_completed":
			var message struct {
				Content string `json:"content"`
			}
			_ = json.Unmarshal(data.Message, &message)
			message.Content = clip(message.Content, 32768)
			data.Message, _ = json.Marshal(message)
		case "error":
			var message string
			_ = json.Unmarshal(data.Message, &message)
			data.Message, _ = json.Marshal(clip(message, 4096))
		default:
			data.Message = nil
		}
	}
	if event.Type == "subagent_event" {
		if data.Event == nil || (data.Event.Type != "tool_started" && data.Event.Type != "assistant_started") {
			return false
		}
		if !displayEvent(data.Event) {
			return false
		}
	} else {
		data.Event = nil
	}
	event.Data, _ = json.Marshal(data)
	return true
}
