package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/nanofuzz/runtime"
	"github.com/nanofuzz/runtime/coverage"
	/* __NANOFUZZ_IMPORTS__ */)

type RunnerInput struct {
	Seq         int64             `json:"seq"`
	Args        []any             `json:"args"`
	Repetitions int               `json:"repetitions"`
	Timeout     int64             `json:"timeout"`
	Validators  []string          `json:"validators"`
	Env         map[string]string `json:"env"`
}

type ValidatorResult struct {
	Tag     string `json:"tag"`
	Value   any    `json:"value,omitempty"`
	Message string `json:"message,omitempty"`
}

type RunnerResultItemPayload struct {
	Tag          string                           `json:"tag"`
	Value        any                              `json:"value,omitempty"`
	Message      string                           `json:"message,omitempty"`
	Name         string                           `json:"name,omitempty"`
	Source       string                           `json:"source,omitempty"`
	Validators   map[string]ValidatorResult       `json:"validators,omitempty"`
	CoverageData map[string]coverage.FileCoverage `json:"coverageData,omitempty"`
}

type RunnerResultPayload struct {
	Results []RunnerResultItemPayload `json:"results"`
	Seq     int64                     `json:"seq"`
}

func writeMsg(payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(data)))
	if _, err := os.Stdout.Write(lenBuf); err != nil {
		return err
	}
	if _, err := os.Stdout.Write(data); err != nil {
		return err
	}
	return nil
}

var MANIFEST = []coverage.FileCoverageSpec{
	/* __NANOFUZZ_COVERAGE_MANIFEST__ */
}

func main() {
	// Send READY handshake message
	if err := writeMsg("READY"); err != nil {
		return
	}

	// Send initial static coverage metadata
	const staticCovJSON = `/* __NANOFUZZ_STATIC_COV_JSON__ */`
	var staticCov any
	_ = json.Unmarshal([]byte(staticCovJSON), &staticCov)
	if err := writeMsg(staticCov); err != nil {
		return
	}

	// Send initialization coverage hits (from init() and top-level var declarations)
	initCov := coverage.TakeMultiHits(MANIFEST)
	if err := writeMsg(initCov); err != nil {
		return
	}

	for {
		lenBuf := make([]byte, 4)
		if _, err := io.ReadFull(os.Stdin, lenBuf); err != nil {
			break
		}
		length := binary.BigEndian.Uint32(lenBuf)
		payload := make([]byte, length)
		if _, err := io.ReadFull(os.Stdin, payload); err != nil {
			break
		}

		var input RunnerInput
		if err := json.Unmarshal(payload, &input); err != nil {
			resp := RunnerResultPayload{
				Results: []RunnerResultItemPayload{
					{
						Tag:     "error",
						Name:    "PayloadDeserializationError",
						Message: err.Error(),
						Source:  "put",
					},
				},
				Seq: -1,
			}
			_ = writeMsg(resp)
			continue
		}

		// Propagate dynamic environment variables (e.g. NANOFUZZ_PROVENANCE for bug elicitation tracking)
		if input.Env != nil {
			for k, v := range input.Env {
				os.Setenv(k, v)
			}
		}

		coverage.Reset()

		/* __NANOFUZZ_ARG_CONVERSIONS__ */

		var results []RunnerResultItemPayload
		var values []any
		var panicked any
		var isSkip bool
		var skipMsg string

		func() {
			defer func() {
				if r := recover(); r != nil {
					if u, ok := r.(runtime.UnsatisfiedAssumptionError); ok {
						isSkip = true
						skipMsg = u.Message
					} else if u, ok := r.(*runtime.UnsatisfiedAssumptionError); ok && u != nil {
						isSkip = true
						skipMsg = u.Message
					} else {
						rStr := fmt.Sprint(r)
						lower := strings.ToLower(rStr)
						if strings.HasPrefix(lower, "unsatisfied assumption") {
							isSkip = true
							prefix := "unsatisfied assumption:"
							if strings.HasPrefix(lower, prefix) {
								skipMsg = strings.TrimSpace(rStr[len(prefix):])
							} else {
								skipMsg = rStr
							}
						} else {
							panicked = r
						}
					}
				}
			}()

			reps := input.Repetitions
			if reps < 1 {
				reps = 1
			}

			if reps > 1 {
				for _r := 0; _r < reps; _r++ {
					var singleOut any
					/* __NANOFUZZ_FN_CALL__ */
					results = append(results, RunnerResultItemPayload{
						Tag:   "value",
						Value: singleOut,
					})
					if singleOut == nil {
						break
					}
				}
			} else {
				var singleOut any
				/* __NANOFUZZ_FN_CALL__ */
				values = append(values, singleOut)
			}
		}()

		covData := coverage.TakeMultiHits(MANIFEST)

		if input.Repetitions > 1 {
			if len(results) > 0 {
				results[0].CoverageData = covData
			}
			resp := RunnerResultPayload{
				Results: results,
				Seq:     input.Seq,
			}
			_ = writeMsg(resp)
			continue
		}

		if isSkip {
			resp := RunnerResultPayload{
				Results: []RunnerResultItemPayload{
					{
						Tag:          "skip",
						Message:      skipMsg,
						CoverageData: covData,
					},
				},
				Seq: input.Seq,
			}
			_ = writeMsg(resp)
			continue
		}

		if panicked != nil {
			resp := RunnerResultPayload{
				Results: []RunnerResultItemPayload{
					{
						Tag:          "error",
						Name:         "Panic",
						Message:      fmt.Sprint(panicked),
						Source:       "put",
						CoverageData: covData,
					},
				},
				Seq: input.Seq,
			}
			_ = writeMsg(resp)
			continue
		}

		var validatorsRes map[string]ValidatorResult
		/* __NANOFUZZ_VALIDATORS__ */

		var singleVal any
		if len(values) > 0 {
			singleVal = values[0]
		}
		resp := RunnerResultPayload{
			Results: []RunnerResultItemPayload{
				{
					Tag:          "value",
					Value:        singleVal,
					Validators:   validatorsRes,
					CoverageData: covData,
				},
			},
			Seq: input.Seq,
		}
		_ = writeMsg(resp)
	}
}
