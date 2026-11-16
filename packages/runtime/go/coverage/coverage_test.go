package coverage_test

import (
	"reflect"
	"testing"

	"github.com/nanofuzz/runtime/coverage"
)

func TestCoverageHitAndTake(t *testing.T) {
	coverage.Reset()

	coverage.HitStmt(1, 0)
	coverage.HitStmt(1, 0)
	coverage.HitStmt(1, 1)

	coverage.HitFn(1, 0)

	coverage.HitBranch(1, 0, 0)
	coverage.HitBranch(1, 0, 1)
	coverage.HitBranch(1, 0, 1)

	manifest := []coverage.FileCoverageSpec{
		{
			FileID:   1,
			FilePath: "/test/file.go",
			BranchArms: []coverage.BranchArmSpec{
				{BranchID: 0, ArmCount: 2},
			},
		},
	}

	result := coverage.TakeMultiHits(manifest)
	fileCov, ok := result["/test/file.go"]
	if !ok {
		t.Fatalf("expected coverage for /test/file.go")
	}

	expectedS := map[string]uint32{"0": 2, "1": 1}
	if !reflect.DeepEqual(fileCov.S, expectedS) {
		t.Errorf("expected S %v, got %v", expectedS, fileCov.S)
	}

	expectedF := map[string]uint32{"0": 1}
	if !reflect.DeepEqual(fileCov.F, expectedF) {
		t.Errorf("expected F %v, got %v", expectedF, fileCov.F)
	}

	expectedB := map[string][]uint32{"0": {1, 2}}
	if !reflect.DeepEqual(fileCov.B, expectedB) {
		t.Errorf("expected B %v, got %v", expectedB, fileCov.B)
	}

	// Verify TakeMultiHits reset hits
	after := coverage.TakeMultiHits(manifest)
	afterCov := after["/test/file.go"]
	if len(afterCov.S) != 0 || len(afterCov.F) != 0 {
		t.Errorf("expected empty hits after take, got %v", afterCov)
	}
}

func TestCoverageReset(t *testing.T) {
	coverage.Reset()
	coverage.HitStmt(1, 5)
	coverage.Reset()

	manifest := []coverage.FileCoverageSpec{
		{
			FileID:   1,
			FilePath: "/test/file.go",
		},
	}

	result := coverage.TakeMultiHits(manifest)
	fileCov := result["/test/file.go"]
	if len(fileCov.S) != 0 {
		t.Errorf("expected 0 hits after reset, got %v", fileCov.S)
	}
}
