package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class AssertTest {

  @Test
  void testAssertThatTruthy() {
    Assert.that(true);
    Assert.that(true, "message");
    Assert.that(10 > 5);
    int a = 2;
    Assert.that(a + a == 4, "math must work");
    Assert.that(true, "formatted %s", "arg");
  }

  @Test
  void testAssertThatFalsyDefaultMessage() {
    AssertionError err = assertThrows(AssertionError.class, () -> Assert.that(false));
    assertEquals("Assertion failed", err.getMessage());
  }

  @Test
  void testAssertThatFalsyCustomMessage() {
    AssertionError err = assertThrows(
        AssertionError.class,
        () -> Assert.that(false, "res must equal sum"));
    assertEquals("res must equal sum", err.getMessage());
  }

  @Test
  void testAssertThatFalsyFormattedMessage() {
    int expected = 10;
    int actual = 20;
    AssertionError err = assertThrows(
        AssertionError.class,
        () -> Assert.that(actual == expected, "expected %d but was %d", expected, actual));
    assertEquals("expected 10 but was 20", err.getMessage());
  }
}
