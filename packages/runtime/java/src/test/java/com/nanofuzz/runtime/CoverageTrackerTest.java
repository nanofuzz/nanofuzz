package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

public class CoverageTrackerTest {

  @Test
  void testSingleFileCoverageRecording() {
    CoverageTracker.reset();

    CoverageTracker.hitFn(0, 0);
    CoverageTracker.hitStmt(0, 0);
    CoverageTracker.hitStmt(0, 1);
    CoverageTracker.hitStmt(0, 1); // Hit twice
    CoverageTracker.hitBranch(0, 0, 1);

    List<CoverageTracker.BranchArmSpec> branchArms = List.of(
        new CoverageTracker.BranchArmSpec(0, 2));

    CoverageTracker.FileCoverage cov = CoverageTracker.takeHits("src/Main.java", branchArms);

    assertEquals("src/Main.java", cov.path);
    assertEquals(1, cov.f.get("0"));
    assertEquals(1, cov.s.get("0"));
    assertEquals(2, cov.s.get("1"));
    assertNull(cov.s.get("2"));

    // Branch arms
    List<Integer> arms = cov.b.get("0");
    assertNotNull(arms);
    assertEquals(2, arms.size());
    assertEquals(0, arms.get(0));
    assertEquals(1, arms.get(1));

    // After takeHits, buffer should be drained
    CoverageTracker.FileCoverage emptyCov = CoverageTracker.takeHits("src/Main.java", branchArms);
    assertTrue(emptyCov.s.isEmpty());
    assertTrue(emptyCov.f.isEmpty());
    assertEquals(List.of(0, 0), emptyCov.b.get("0"));
  }

  @Test
  void testMultiFileCoverageNoCollisions() {
    CoverageTracker.reset();

    // File 0: src/Main.java
    CoverageTracker.hitFn(0, 0);
    CoverageTracker.hitStmt(0, 0);
    CoverageTracker.hitStmt(0, 5);
    CoverageTracker.hitBranch(0, 0, 0);

    // File 1: src/Helper.java - using the same statement and function indices (0,
    // 0)
    CoverageTracker.hitFn(1, 0);
    CoverageTracker.hitStmt(1, 0);
    CoverageTracker.hitStmt(1, 10);
    CoverageTracker.hitBranch(1, 0, 1);

    List<CoverageTracker.BranchArmSpec> branchArmsF0 = List.of(new CoverageTracker.BranchArmSpec(0, 2));
    List<CoverageTracker.BranchArmSpec> branchArmsF1 = List.of(new CoverageTracker.BranchArmSpec(0, 2));

    List<CoverageTracker.FileCoverageSpec> manifest = List.of(
        new CoverageTracker.FileCoverageSpec(0, "src/Main.java", branchArmsF0),
        new CoverageTracker.FileCoverageSpec(1, "src/Helper.java", branchArmsF1));

    Map<String, CoverageTracker.FileCoverage> results = CoverageTracker.takeMultiHits(manifest);

    assertEquals(2, results.size());

    CoverageTracker.FileCoverage cov0 = results.get("src/Main.java");
    assertNotNull(cov0);
    assertEquals(1, cov0.f.get("0"));
    assertEquals(1, cov0.s.get("0"));
    assertEquals(1, cov0.s.get("5"));
    assertNull(cov0.s.get("10"));

    CoverageTracker.FileCoverage cov1 = results.get("src/Helper.java");
    assertNotNull(cov1);
    assertEquals(1, cov1.f.get("0"));
    assertEquals(1, cov1.s.get("0"));
    assertEquals(1, cov1.s.get("10"));
    assertNull(cov1.s.get("5"));
  }

  @Test
  void testToJsonSerialization() {
    CoverageTracker.reset();
    CoverageTracker.hitStmt(0, 1);
    CoverageTracker.hitFn(0, 0);
    CoverageTracker.hitBranch(0, 2, 0);

    List<CoverageTracker.FileCoverageSpec> manifest = List.of(
        new CoverageTracker.FileCoverageSpec(
            0,
            "src/App.java",
            List.of(new CoverageTracker.BranchArmSpec(2, 2))));

    Map<String, CoverageTracker.FileCoverage> map = CoverageTracker.takeMultiHits(manifest);
    String json = CoverageTracker.toJson(map);

    assertTrue(json.contains("\"src/App.java\""));
    assertTrue(json.contains("\"path\":\"src/App.java\""));
    assertTrue(json.contains("\"s\":{\"1\":1}"));
    assertTrue(json.contains("\"f\":{\"0\":1}"));
    assertTrue(json.contains("\"b\":{\"2\":[1,0]}"));
  }
}
