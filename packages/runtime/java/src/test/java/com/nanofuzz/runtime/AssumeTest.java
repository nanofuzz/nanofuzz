package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class AssumeTest {

  @Test
  void testAssumeTruthy() {
    assertTrue(Assume.assume(true));
    assertTrue(Assume.assume(true, "should not throw"));
    assertTrue(Assume.assume(true, "format %s", "arg"));
  }

  @Test
  void testAssumeFalsyDefaultMessage() {
    UnsatisfiedAssumptionException ex = assertThrows(
        UnsatisfiedAssumptionException.class,
        () -> Assume.assume(false));
    assertEquals("Unsatisfied assumption", ex.getMessage());
  }

  @Test
  void testAssumeFalsyCustomMessage() {
    UnsatisfiedAssumptionException ex = assertThrows(
        UnsatisfiedAssumptionException.class,
        () -> Assume.assume(false, "n cannot be negative"));
    assertEquals("n cannot be negative", ex.getMessage());
  }

  @Test
  void testAssumeFalsyFormattedMessage() {
    int x = -5;
    UnsatisfiedAssumptionException ex = assertThrows(
        UnsatisfiedAssumptionException.class,
        () -> Assume.assume(x > 0, "x was %d, expected positive", x));
    assertEquals("x was -5, expected positive", ex.getMessage());
  }
}
