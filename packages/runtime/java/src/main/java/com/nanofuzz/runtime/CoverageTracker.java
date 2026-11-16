package com.nanofuzz.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * In-process coverage tracking module for NaNofuzz.
 */
public final class CoverageTracker {

  private CoverageTracker() {
  }

  /**
   * File coverage data matching Istanbul's FileCoverageData schema.
   */
  public static class FileCoverage {
    public final String path;
    public final Map<String, Integer> s = new LinkedHashMap<>();
    public final Map<String, Integer> f = new LinkedHashMap<>();
    public final Map<String, List<Integer>> b = new LinkedHashMap<>();

    public FileCoverage(String path) {
      this.path = path;
    }
  }

  /**
   * Specification of branch arms for a branch ID: (branchId, armCount).
   */
  public record BranchArmSpec(int branchId, int armCount) {
  }

  /**
   * Specification of a file in the coverage manifest: (fileId, filePath,
   * branchArms).
   */
  public record FileCoverageSpec(int fileId, String filePath, List<BranchArmSpec> branchArms) {
  }

  private static final ThreadLocal<List<long[]>> HIT_STMTS = ThreadLocal.withInitial(ArrayList::new);
  private static final ThreadLocal<List<long[]>> HIT_FNS = ThreadLocal.withInitial(ArrayList::new);
  private static final ThreadLocal<List<long[]>> HIT_BRANCHES = ThreadLocal.withInitial(ArrayList::new);

  /**
   * Records execution of statement with index id in file with fileId.
   *
   * @param fileId Numeric file identifier
   * @param id     Statement index
   */
  public static void hitStmt(int fileId, int id) {
    HIT_STMTS.get().add(new long[] { fileId, id });
  }

  /**
   * Records execution of function with index id in file with fileId.
   *
   * @param fileId Numeric file identifier
   * @param id     Function index
   */
  public static void hitFn(int fileId, int id) {
    HIT_FNS.get().add(new long[] { fileId, id });
  }

  /**
   * Records execution of branch with index branchId and arm armId in file with
   * fileId.
   *
   * @param fileId   Numeric file identifier
   * @param branchId Branch index
   * @param armId    Branch arm index
   */
  public static void hitBranch(int fileId, int branchId, int armId) {
    HIT_BRANCHES.get().add(new long[] { fileId, branchId, armId });
  }

  /**
   * Resets all recorded coverage hits across all files for the current thread.
   */
  public static void reset() {
    HIT_STMTS.get().clear();
    HIT_FNS.get().clear();
    HIT_BRANCHES.get().clear();
  }

  /**
   * Drains and returns the recorded coverage hits for a single file.
   *
   * @param filePath   Path of the file
   * @param branchArms Branch specifications
   * @return FileCoverage snapshot
   */
  public static FileCoverage takeHits(String filePath, List<BranchArmSpec> branchArms) {
    List<FileCoverageSpec> specs = List.of(new FileCoverageSpec(0, filePath, branchArms));
    Map<String, FileCoverage> map = takeMultiHits(specs);
    return map.getOrDefault(filePath, new FileCoverage(filePath));
  }

  /**
   * Drains and returns the recorded coverage hits for multiple files described by
   * manifest.
   *
   * @param manifest List of FileCoverageSpec entries
   * @return Map of file path to FileCoverage data
   */
  public static Map<String, FileCoverage> takeMultiHits(List<FileCoverageSpec> manifest) {
    List<long[]> stmts = new ArrayList<>(HIT_STMTS.get());
    List<long[]> fns = new ArrayList<>(HIT_FNS.get());
    List<long[]> branches = new ArrayList<>(HIT_BRANCHES.get());
    reset();

    Map<Integer, Map<String, Integer>> stmtsByFile = new HashMap<>();
    for (long[] s : stmts) {
      int fid = (int) s[0];
      int sid = (int) s[1];
      stmtsByFile.computeIfAbsent(fid, k -> new LinkedHashMap<>())
          .merge(String.valueOf(sid), 1, Integer::sum);
    }

    Map<Integer, Map<String, Integer>> fnsByFile = new HashMap<>();
    for (long[] f : fns) {
      int fid = (int) f[0];
      int fnid = (int) f[1];
      fnsByFile.computeIfAbsent(fid, k -> new LinkedHashMap<>())
          .merge(String.valueOf(fnid), 1, Integer::sum);
    }

    Map<Integer, List<long[]>> branchesByFile = new HashMap<>();
    for (long[] b : branches) {
      int fid = (int) b[0];
      branchesByFile.computeIfAbsent(fid, k -> new ArrayList<>()).add(b);
    }

    Map<String, FileCoverage> result = new LinkedHashMap<>();
    for (FileCoverageSpec spec : manifest) {
      FileCoverage cov = new FileCoverage(spec.filePath());
      Map<String, Integer> fileStmts = stmtsByFile.getOrDefault(spec.fileId(), Collections.emptyMap());
      cov.s.putAll(fileStmts);

      Map<String, Integer> fileFns = fnsByFile.getOrDefault(spec.fileId(), Collections.emptyMap());
      cov.f.putAll(fileFns);

      // Pre-populate branch arms with zeros
      if (spec.branchArms() != null) {
        for (BranchArmSpec armSpec : spec.branchArms()) {
          List<Integer> armList = new ArrayList<>(Collections.nCopies(armSpec.armCount(), 0));
          cov.b.put(String.valueOf(armSpec.branchId()), armList);
        }
      }

      List<long[]> branchHits = branchesByFile.getOrDefault(spec.fileId(), Collections.emptyList());
      for (long[] bh : branchHits) {
        String bKey = String.valueOf((int) bh[1]);
        int arm = (int) bh[2];
        List<Integer> arms = cov.b.get(bKey);
        if (arms != null && arm >= 0 && arm < arms.size()) {
          arms.set(arm, arms.get(arm) + 1);
        }
      }

      result.put(spec.filePath(), cov);
    }

    return result;
  }

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /**
   * Serializes a map of FileCoverage data to an Istanbul-compatible JSON string.
   *
   * @param coverageMap Map of file path to FileCoverage data
   * @return Istanbul-compatible JSON string
   */
  public static String toJson(Map<String, FileCoverage> coverageMap) {
    try {
      return MAPPER.writeValueAsString(coverageMap);
    } catch (Exception e) {
      throw new RuntimeException("Failed to serialize coverage map to JSON", e);
    }
  }
}
