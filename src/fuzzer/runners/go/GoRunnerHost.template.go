package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/nanofuzz/runtime"
	"github.com/nanofuzz/runtime/coverage"
	/* __NANOFUZZ_IMPORTS__ */)

type RunnerInput struct {
	Seq        int64    `json:"seq"`
	Args       []any    `json:"args"`
	Validators []string `json:"validators"`
}

type ValidatorResult struct {
	Tag     string `json:"tag"`
	Value   any    `json:"value,omitempty"`
	Message string `json:"message,omitempty"`
}

type RunnerResultPayload struct {
	Tag          string                           `json:"tag"`
	Value        any                              `json:"value,omitempty"`
	Message      string                           `json:"message,omitempty"`
	Name         string                           `json:"name,omitempty"`
	Source       string                           `json:"source,omitempty"`
	Seq          int64                            `json:"seq"`
	Validators   map[string]ValidatorResult       `json:"validators,omitempty"`
	CoverageData map[string]coverage.FileCoverage `json:"coverageData,omitempty"`
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
				Tag:     "error",
				Name:    "PayloadDeserializationError",
				Message: err.Error(),
				Source:  "put",
				Seq:     -1,
			}
			_ = writeMsg(resp)
			continue
		}

		coverage.Reset()

		/* __NANOFUZZ_ARG_CONVERSIONS__ */

		var outVal any
		var panicked any
		var isSkip bool
		var skipMsg string

		func() {
			defer func() {
				if r := recover(); r != nil {
					if u, ok := r.(runtime.UnsatisfiedAssumptionError); ok {
						isSkip = true
						skipMsg = u.Message
					} else {
						panicked = r
					}
				}
			}()
			/* __NANOFUZZ_FN_CALL__ */
		}()

		covData := coverage.TakeMultiHits(MANIFEST)

		if isSkip {
			resp := RunnerResultPayload{
				Tag:          "skip",
				Message:      skipMsg,
				Seq:          input.Seq,
				CoverageData: covData,
			}
			_ = writeMsg(resp)
			continue
		}

		if panicked != nil {
			resp := RunnerResultPayload{
				Tag:          "error",
				Name:         "Panic",
				Message:      fmt.Sprint(panicked),
				Source:       "put",
				Seq:          input.Seq,
				CoverageData: covData,
			}
			_ = writeMsg(resp)
			continue
		}

		var validatorsRes map[string]ValidatorResult
		/* __NANOFUZZ_VALIDATORS__ */

		resp := RunnerResultPayload{
			Tag:          "value",
			Value:        outVal,
			Seq:          input.Seq,
			Validators:   validatorsRes,
			CoverageData: covData,
		}
		_ = writeMsg(resp)
	}
}
