package coverage

import (
	"strconv"
	"sync"
)

// FileCoverage represents statement, function, and branch coverage for a single file.
type FileCoverage struct {
	Path string              `json:"path"`
	S    map[string]uint32   `json:"s"`
	F    map[string]uint32   `json:"f"`
	B    map[string][]uint32 `json:"b"`
}

// BranchArmSpec specifies the number of arms for a given branch.
type BranchArmSpec struct {
	BranchID uint32 `json:"branchId"`
	ArmCount int    `json:"armCount"`
}

// FileCoverageSpec specifies coverage metadata for a source file.
type FileCoverageSpec struct {
	FileID     uint32          `json:"fileId"`
	FilePath   string          `json:"filePath"`
	BranchArms []BranchArmSpec `json:"branchArms"`
}

var (
	mu          sync.Mutex
	hitStmts    = make(map[uint32]map[uint32]uint32)
	hitFns      = make(map[uint32]map[uint32]uint32)
	hitBranches = make(map[uint32]map[uint32]map[uint32]uint32)
)

// HitStmt records execution of statement id in file fileID.
func HitStmt(fileID, id uint32) {
	mu.Lock()
	defer mu.Unlock()
	m, ok := hitStmts[fileID]
	if !ok {
		m = make(map[uint32]uint32)
		hitStmts[fileID] = m
	}
	m[id]++
}

// HitFn records execution of function id in file fileID.
func HitFn(fileID, id uint32) {
	mu.Lock()
	defer mu.Unlock()
	m, ok := hitFns[fileID]
	if !ok {
		m = make(map[uint32]uint32)
		hitFns[fileID] = m
	}
	m[id]++
}

// HitBranch records execution of branch branchID, arm armID in file fileID.
func HitBranch(fileID, branchID, armID uint32) {
	mu.Lock()
	defer mu.Unlock()
	bMap, ok := hitBranches[fileID]
	if !ok {
		bMap = make(map[uint32]map[uint32]uint32)
		hitBranches[fileID] = bMap
	}
	arms, ok := bMap[branchID]
	if !ok {
		arms = make(map[uint32]uint32)
		bMap[branchID] = arms
	}
	arms[armID]++
}

// Reset clears all recorded coverage hits.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	hitStmts = make(map[uint32]map[uint32]uint32)
	hitFns = make(map[uint32]map[uint32]uint32)
	hitBranches = make(map[uint32]map[uint32]map[uint32]uint32)
}

// TakeMultiHits collects and resets recorded coverage hits, structuring them according to the manifest.
func TakeMultiHits(manifest []FileCoverageSpec) map[string]FileCoverage {
	mu.Lock()
	stmts := hitStmts
	fns := hitFns
	branches := hitBranches
	hitStmts = make(map[uint32]map[uint32]uint32)
	hitFns = make(map[uint32]map[uint32]uint32)
	hitBranches = make(map[uint32]map[uint32]map[uint32]uint32)
	mu.Unlock()

	result := make(map[string]FileCoverage, len(manifest))

	for _, spec := range manifest {
		sMap := make(map[string]uint32)
		if fileStmts, ok := stmts[spec.FileID]; ok {
			for sid, count := range fileStmts {
				sMap[strconv.FormatUint(uint64(sid), 10)] = count
			}
		}

		fMap := make(map[string]uint32)
		if fileFns, ok := fns[spec.FileID]; ok {
			for fid, count := range fileFns {
				fMap[strconv.FormatUint(uint64(fid), 10)] = count
			}
		}

		bMap := make(map[string][]uint32, len(spec.BranchArms))
		fileBranchHits := branches[spec.FileID]
		for _, armSpec := range spec.BranchArms {
			armHits := make([]uint32, armSpec.ArmCount)
			if fileBranchHits != nil {
				if hitCounts, ok := fileBranchHits[armSpec.BranchID]; ok {
					for armIdx, count := range hitCounts {
						if int(armIdx) < len(armHits) {
							armHits[armIdx] = count
						}
					}
				}
			}
			bMap[strconv.FormatUint(uint64(armSpec.BranchID), 10)] = armHits
		}

		result[spec.FilePath] = FileCoverage{
			Path: spec.FilePath,
			S:    sMap,
			F:    fMap,
			B:    bMap,
		}
	}

	return result
}
