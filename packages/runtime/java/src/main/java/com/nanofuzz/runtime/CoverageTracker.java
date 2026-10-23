package com.nanofuzz.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

  /**
   * Serializes a map of FileCoverage data to an Istanbul-compatible JSON string
   * without external dependencies.
   *
   * @param coverageMap Map of file path to FileCoverage data
   * @return Istanbul-compatible JSON string
   */
  public static String toJson(Map<String, FileCoverage> coverageMap) {
    StringBuilder sb = new StringBuilder("{");
    boolean firstFile = true;
    for (Map.Entry<String, FileCoverage> entry : coverageMap.entrySet()) {
      if (!firstFile)
        sb.append(",");
      firstFile = false;
      sb.append(quote(entry.getKey())).append(":");
      FileCoverage cov = entry.getValue();
      sb.append("{");
      sb.append("\"path\":").append(quote(cov.path)).append(",");

      // s
      sb.append("\"s\":{");
      boolean firstS = true;
      for (Map.Entry<String, Integer> sEntry : cov.s.entrySet()) {
        if (!firstS)
          sb.append(",");
        firstS = false;
        sb.append(quote(sEntry.getKey())).append(":").append(sEntry.getValue());
      }
      sb.append("},");

      // f
      sb.append("\"f\":{");
      boolean firstF = true;
      for (Map.Entry<String, Integer> fEntry : cov.f.entrySet()) {
        if (!firstF)
          sb.append(",");
        firstF = false;
        sb.append(quote(fEntry.getKey())).append(":").append(fEntry.getValue());
      }
      sb.append("},");

      // b
      sb.append("\"b\":{");
      boolean firstB = true;
      for (Map.Entry<String, List<Integer>> bEntry : cov.b.entrySet()) {
        if (!firstB)
          sb.append(",");
        firstB = false;
        sb.append(quote(bEntry.getKey())).append(":[");
        List<Integer> arms = bEntry.getValue();
        for (int i = 0; i < arms.size(); i++) {
          if (i > 0)
            sb.append(",");
          sb.append(arms.get(i));
        }
        sb.append("]");
      }
      sb.append("}");

      sb.append("}");
    }
    sb.append("}");
    return sb.toString();
  }

  private static String quote(String s) {
    if (s == null)
      return "null";
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 32) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
        }
      }
    }
    sb.append("\"");
    return sb.toString();
  }
}
