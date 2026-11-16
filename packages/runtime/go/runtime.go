package runtime

import "fmt"

// Version of the nanofuzz runtime for Go.
const Version = "0.5.0"

// FuzzTestResult represents the input and output of a single fuzz run.
type FuzzTestResult struct {
	In        []any `json:"in"`
	Out       any   `json:"out"`
	Exception bool  `json:"exception"`
	Timeout   bool  `json:"timeout"`
}

// ValidatorResult represents the outcome of a property test validator.
type ValidatorResult string

const (
	Pass    ValidatorResult = "pass"
	Fail    ValidatorResult = "fail"
	Unknown ValidatorResult = "unknown"
)

// UnsatisfiedAssumptionError is panicked when an Assume precondition fails.
type UnsatisfiedAssumptionError struct {
	Message string
}

func (e UnsatisfiedAssumptionError) Error() string {
	return fmt.Sprintf("unsatisfied assumption: %s", e.Message)
}

// Assume filters out invalid test inputs. If condition is false, it panics with UnsatisfiedAssumptionError.
func Assume(condition bool, msg ...string) {
	if !condition {
		m := "precondition not met"
		if len(msg) > 0 && msg[0] != "" {
			m = msg[0]
		}
		panic(UnsatisfiedAssumptionError{Message: m})
	}
}
