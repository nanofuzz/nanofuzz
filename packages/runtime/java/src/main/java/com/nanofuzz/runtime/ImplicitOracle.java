package com.nanofuzz.runtime;

import java.util.Collection;
import java.util.Map;
import java.util.Optional;

/**
 * Evaluates values against the NaNofuzz heuristic / implicit oracle.
 * Fails (returns false) if the value is null, or contains null, NaN, or
 * Infinity.
 */
public final class ImplicitOracle {

  private ImplicitOracle() {
  }

  /**
   * Evaluates a value against the implicit oracle.
   *
   * @param val Value to inspect
   * @return True if clean; false if null, NaN, or Infinite
   */
  public static boolean check(Object val) {
    if (val == null) {
      return false;
    }
    if (val instanceof Double d) {
      return !d.isNaN() && !d.isInfinite();
    }
    if (val instanceof Float f) {
      return !f.isNaN() && !f.isInfinite();
    }
    if (val instanceof Optional<?> opt) {
      return opt.isPresent() && check(opt.get());
    }
    if (val instanceof Collection<?> col) {
      for (Object item : col) {
        if (!check(item)) {
          return false;
        }
      }
      return true;
    }
    if (val instanceof Map<?, ?> map) {
      for (Object item : map.values()) {
        if (!check(item)) {
          return false;
        }
      }
      return true;
    }
    if (val.getClass().isArray()) {
      if (val instanceof Object[] arr) {
        for (Object item : arr) {
          if (!check(item)) {
            return false;
          }
        }
        return true;
      }
      if (val instanceof double[] arr) {
        for (double d : arr) {
          if (Double.isNaN(d) || Double.isInfinite(d)) {
            return false;
          }
        }
        return true;
      }
      if (val instanceof float[] arr) {
        for (float f : arr) {
          if (Float.isNaN(f) || Float.isInfinite(f)) {
            return false;
          }
        }
        return true;
      }
      return true;
    }
    return true;
  }
}
