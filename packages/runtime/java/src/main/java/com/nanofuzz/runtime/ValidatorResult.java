package com.nanofuzz.runtime;

/**
 * Outcome of a property validator evaluation.
 */
public enum ValidatorResult {
  PASS("pass"),
  FAIL("fail"),
  UNKNOWN("unknown");

  private final String value;

  ValidatorResult(String value) {
    this.value = value;
  }

  /**
   * Returns the lowercase string representation ("pass", "fail", or "unknown").
   *
   * @return Lowercase string value
   */
  public String asStr() {
    return value;
  }

  /**
   * Returns the lowercase string representation ("pass", "fail", or "unknown").
   *
   * @return Lowercase string value
   */
  public String getValue() {
    return value;
  }

  /**
   * Converts an arbitrary object into a ValidatorResult.
   *
   * @param obj Result object
   * @return Corresponding ValidatorResult
   */
  public static ValidatorResult from(Object obj) {
    if (obj instanceof ValidatorResult vr) {
      return vr;
    }
    if (obj instanceof Boolean b) {
      return from(b.booleanValue());
    }
    if (obj instanceof String s) {
      return from(s);
    }
    return UNKNOWN;
  }

  /**
   * Converts a boolean into a ValidatorResult (true -> PASS, false -> FAIL).
   *
   * @param passed Boolean test assertion
   * @return ValidatorResult.PASS if true, ValidatorResult.FAIL if false
   */
  public static ValidatorResult from(boolean passed) {
    return passed ? PASS : FAIL;
  }

  /**
   * Converts a string to a ValidatorResult ("pass" -> PASS, "fail" -> FAIL, else
   * UNKNOWN).
   *
   * @param s String representation
   * @return Corresponding ValidatorResult
   */
  public static ValidatorResult from(String s) {
    if (s == null) {
      return UNKNOWN;
    }
    String trimmed = s.trim().toLowerCase();
    return switch (trimmed) {
      case "pass", "true" -> PASS;
      case "fail", "false" -> FAIL;
      default -> UNKNOWN;
    };
  }
}
