package com.nanofuzz.runtime;

/**
 * Precondition check methods for input transformers.
 */
public final class Assume {

  private Assume() {
  }

  /**
   * Asserts that a condition is true; throws UnsatisfiedAssumptionException if
   * false.
   *
   * @param condition The condition to test
   * @return true if the condition is satisfied
   */
  public static boolean assume(boolean condition) {
    return assume(condition, "Unsatisfied assumption");
  }

  /**
   * Asserts that a condition is true; throws UnsatisfiedAssumptionException with
   * message if false.
   *
   * @param condition The condition to test
   * @param message   Message explaining why the assumption failed
   * @return true if the condition is satisfied
   */
  public static boolean assume(boolean condition, String message) {
    if (!condition) {
      throw new UnsatisfiedAssumptionException(message);
    }
    return true;
  }

  /**
   * Asserts that a condition is true with formatted message; throws
   * UnsatisfiedAssumptionException if false.
   *
   * @param condition The condition to test
   * @param format    Format string
   * @param args      Arguments for format string
   * @return true if the condition is satisfied
   */
  public static boolean assume(boolean condition, String format, Object... args) {
    if (!condition) {
      throw new UnsatisfiedAssumptionException(String.format(format, args));
    }
    return true;
  }

  /**
   * Asserts that a condition is true; throws UnsatisfiedAssumptionException if
   * false.
   *
   * @param condition The condition to test
   * @return true if the condition is satisfied
   */
  public static boolean that(boolean condition) {
    return assume(condition);
  }

  /**
   * Asserts that a condition is true; throws UnsatisfiedAssumptionException with
   * message if false.
   *
   * @param condition The condition to test
   * @param message   Message explaining why the assumption failed
   * @return true if the condition is satisfied
   */
  public static boolean that(boolean condition, String message) {
    return assume(condition, message);
  }

  /**
   * Asserts that a condition is true with formatted message; throws
   * UnsatisfiedAssumptionException if false.
   *
   * @param condition The condition to test
   * @param format    Format string
   * @param args      Arguments for format string
   * @return true if the condition is satisfied
   */
  public static boolean that(boolean condition, String format, Object... args) {
    return assume(condition, format, args);
  }
}
