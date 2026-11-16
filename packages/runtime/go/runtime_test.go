package runtime_test

import (
	"math"
	"testing"

	"github.com/nanofuzz/runtime"
	"github.com/nanofuzz/runtime/coverage"
)

func TestAssume(t *testing.T) {
	// Should not panic on true
	runtime.Assume(true, "must be true")

	// Should panic with UnsatisfiedAssumptionError on false
	defer func() {
		r := recover()
		if r == nil {
			t.Errorf("expected Assume(false) to panic, but it did not")
		}
		if _, ok := r.(runtime.UnsatisfiedAssumptionError); !ok {
			t.Errorf("expected UnsatisfiedAssumptionError panic, got %T: %v", r, r)
		}
	}()
	runtime.Assume(false, "should fail")
}

func TestImplicitOracle(t *testing.T) {
	if runtime.ImplicitOracle(nil) {
		t.Errorf("expected nil to fail ImplicitOracle")
	}
	if runtime.ImplicitOracle(math.NaN()) {
		t.Errorf("expected NaN to fail ImplicitOracle")
	}
	if runtime.ImplicitOracle(math.Inf(1)) {
		t.Errorf("expected +Inf to fail ImplicitOracle")
	}
	if !runtime.ImplicitOracle(42) {
		t.Errorf("expected 42 to pass ImplicitOracle")
	}
	if !runtime.ImplicitOracle("valid string") {
		t.Errorf("expected valid string to pass ImplicitOracle")
	}

	sliceWithNaN := []float64{1.0, math.NaN(), 3.0}
	if runtime.ImplicitOracle(sliceWithNaN) {
		t.Errorf("expected slice containing NaN to fail ImplicitOracle")
	}

	validSlice := []int{1, 2, 3}
	if !runtime.ImplicitOracle(validSlice) {
		t.Errorf("expected valid slice to pass ImplicitOracle")
	}
}

func TestCoverageTracking(t *testing.T) {
	coverage.Reset()

	coverage.HitStmt(1, 0)
	coverage.HitStmt(1, 0)
	coverage.HitStmt(1, 1)
	coverage.HitFn(1, 0)
	coverage.HitBranch(1, 0, 1)

	manifest := []coverage.FileCoverageSpec{
		{
			FileID:   1,
			FilePath: "/path/to/file.go",
			BranchArms: []coverage.BranchArmSpec{
				{BranchID: 0, ArmCount: 2},
			},
		},
	}

	covMap := coverage.TakeMultiHits(manifest)
	fileCov, ok := covMap["/path/to/file.go"]
	if !ok {
		t.Fatalf("missing /path/to/file.go in coverage output")
	}

	if fileCov.S["0"] != 2 || fileCov.S["1"] != 1 {
		t.Errorf("unexpected statement hits: %v", fileCov.S)
	}
	if fileCov.F["0"] != 1 {
		t.Errorf("unexpected function hits: %v", fileCov.F)
	}
	if len(fileCov.B["0"]) != 2 || fileCov.B["0"][0] != 0 || fileCov.B["0"][1] != 1 {
		t.Errorf("unexpected branch hits: %v", fileCov.B)
	}
}
