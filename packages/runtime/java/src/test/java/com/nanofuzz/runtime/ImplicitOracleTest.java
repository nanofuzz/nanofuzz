package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import static org.junit.jupiter.api.Assertions.*;

public class ImplicitOracleTest {

  @Test
  void testCleanValuesPass() {
    assertTrue(ImplicitOracle.check(42));
    assertTrue(ImplicitOracle.check("hello"));
    assertTrue(ImplicitOracle.check(true));
    assertTrue(ImplicitOracle.check(List.of(1, 2, 3)));
    assertTrue(ImplicitOracle.check(Set.of("a", "b")));
    assertTrue(ImplicitOracle.check(Map.of("k", 100)));
    assertTrue(ImplicitOracle.check(Optional.of(99)));
    assertTrue(ImplicitOracle.check(new int[] { 1, 2, 3 }));
    assertTrue(ImplicitOracle.check(new double[] { 1.0, 2.5 }));
  }

  @Test
  void testNullFails() {
    assertFalse(ImplicitOracle.check(null));
    assertFalse(ImplicitOracle.check(Optional.empty()));
  }

  @Test
  void testNanAndInfinityFail() {
    assertFalse(ImplicitOracle.check(Double.NaN));
    assertFalse(ImplicitOracle.check(Double.POSITIVE_INFINITY));
    assertFalse(ImplicitOracle.check(Double.NEGATIVE_INFINITY));
    assertFalse(ImplicitOracle.check(Float.NaN));
    assertFalse(ImplicitOracle.check(Float.POSITIVE_INFINITY));
    assertFalse(ImplicitOracle.check(Float.NEGATIVE_INFINITY));
    assertFalse(ImplicitOracle.check(new double[] { 1.0, Double.NaN }));
    assertFalse(ImplicitOracle.check(new float[] { Float.POSITIVE_INFINITY }));
  }

  @Test
  void testNestedCollectionsWithNullsOrNansFail() {
    assertFalse(ImplicitOracle.check(List.of(Double.NaN)));
    assertFalse(ImplicitOracle.check(new Object[] { 1, null, 3 }));
  }
}
