package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

public class FuzzTestResultTest {

  @Test
  void testFuzzTestResultAccessors() {
    List<Object> inputs = List.of(42, "hello", List.of(1, 2, 3));
    FuzzTestResult result = new FuzzTestResult(inputs, 84.5, false, false);

    assertEquals(Integer.valueOf(42), result.getIn(0));
    assertEquals("hello", result.getIn(1));
    assertEquals(List.of(1, 2, 3), result.getIn(2));

    assertEquals(Double.valueOf(84.5), result.getOut());
    assertEquals(inputs, result.getInputs());
    assertEquals(inputs, result.inputs());
    assertEquals(inputs, result.in());
    assertEquals(84.5, result.getOutput());
    assertEquals(84.5, result.out());

    assertFalse(result.isException());
    assertFalse(result.exception());
    assertFalse(result.isTimeout());
    assertFalse(result.timeout());
  }

  @Test
  void testOutOfBoundsThrows() {
    FuzzTestResult result = new FuzzTestResult(List.of(1), 2, false, false);
    assertThrows(IndexOutOfBoundsException.class, () -> result.getIn(1));
    assertThrows(IndexOutOfBoundsException.class, () -> result.getIn(-1));
  }

  @Test
  void testEqualityAndToString() {
    FuzzTestResult r1 = new FuzzTestResult(List.of("a"), 1, false, false);
    FuzzTestResult r2 = new FuzzTestResult(List.of("a"), 1, false, false);
    FuzzTestResult r3 = new FuzzTestResult(List.of("b"), 1, false, false);

    assertEquals(r1, r2);
    assertEquals(r1.hashCode(), r2.hashCode());
    assertNotEquals(r1, r3);
    assertTrue(r1.toString().contains("in=[a]"));
  }

  @Test
  void testVersionExported() {
    assertNotNull(NanofuzzRuntime.VERSION);
    assertFalse(NanofuzzRuntime.VERSION.isEmpty());
  }
}
