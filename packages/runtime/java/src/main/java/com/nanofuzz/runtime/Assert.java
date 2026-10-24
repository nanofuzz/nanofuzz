package com.nanofuzz.runtime;

/**
 * Zero-dependency assertion utility for NaNofuzz test harnesses and property
 * targets.
 *
 * Unlike Java's built-in assert statement which requires the -ea JVM flag to be
 * enabled,
 * Assert.that(...) always executes and throws java.lang.AssertionError when the
 * condition is false.
 */
public final class Assert {

  private Assert() {
  }

  /**
   * Asserts that a condition is true.
   *
   * @param condition The condition to evaluate
   * @throws AssertionError If the condition is false
   */
  public static void that(boolean condition) {
    that(condition, "Assertion failed");
  }

  /**
   * Asserts that a condition is true with a custom message.
   *
   * @param condition The condition to evaluate
   * @param message   Failure message
   * @throws AssertionError If the condition is false
   */
  public static void that(boolean condition, String message) {
    if (!condition) {
      throw new AssertionError(message != null ? message : "Assertion failed");
    }
  }

  /**
   * Asserts that a condition is true with a formatted message.
   *
   * @param condition The condition to evaluate
   * @param format    Message format string
   * @param args      Format arguments
   * @throws AssertionError If the condition is false
   */
  public static void that(boolean condition, String format, Object... args) {
    if (!condition) {
      throw new AssertionError(String.format(format, args));
    }
  }
}
