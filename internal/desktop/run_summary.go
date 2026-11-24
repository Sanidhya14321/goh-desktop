package desktop

type RunContext struct {
	Agent string `json:"agent,omitempty"`
	Mode  string `json:"agent_mode,omitempty"`
}

type CheckEvidence struct {
	Source   string `json:"source,omitempty"`
	Command  string `json:"command,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Scope    string `json:"scope,omitempty"`
	Passed   *bool  `json:"passed,omitempty"`
	ExitCode *int   `json:"exit_code,omitempty"`
	Revision string `json:"revision,omitempty"`
}

type VerificationDetail struct {
	ChangeTracking string         `json:"change_tracking,omitempty"`
	Evidence       *CheckEvidence `json:"evidence,omitempty"`
}

type RunSummary struct {
	RunContext
	ID           string              `json:"run_id,omitempty"`
	Operation    string              `json:"operation,omitempty"`
	Status       string              `json:"status,omitempty"`
	Outcome      string              `json:"outcome,omitempty"`
	Duration     *int64              `json:"duration_ms,omitempty"`
	Time         int64               `json:"time,omitempty"`
	Verification *VerificationDetail `json:"verification_detail,omitempty"`
}

func (r *RunSummary) limitDisplay() {
	if r.Verification != nil && r.Verification.Evidence != nil {
		r.Verification.Evidence.Command = clip(r.Verification.Evidence.Command, 4096)
		r.Verification.Evidence.Revision = clip(r.Verification.Evidence.Revision, 256)
	}
}
