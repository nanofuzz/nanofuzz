package com.nanofuzz.runtime;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class ValidatorResultTest {

  @Test
  void testEnumValuesAndStrings() {
    assertEquals("pass", ValidatorResult.PASS.asStr());
    assertEquals("fail", ValidatorResult.FAIL.asStr());
    assertEquals("unknown", ValidatorResult.UNKNOWN.asStr());

    assertEquals("pass", ValidatorResult.PASS.getValue());
    assertEquals("fail", ValidatorResult.FAIL.getValue());
    assertEquals("unknown", ValidatorResult.UNKNOWN.getValue());
  }

  @Test
  void testFromBoolean() {
    assertEquals(ValidatorResult.PASS, ValidatorResult.from(true));
    assertEquals(ValidatorResult.FAIL, ValidatorResult.from(false));
  }

  @Test
  void testFromString() {
    assertEquals(ValidatorResult.PASS, ValidatorResult.from("pass"));
    assertEquals(ValidatorResult.PASS, ValidatorResult.from("PASS"));
    assertEquals(ValidatorResult.PASS, ValidatorResult.from("true"));

    assertEquals(ValidatorResult.FAIL, ValidatorResult.from("fail"));
    assertEquals(ValidatorResult.FAIL, ValidatorResult.from("FAIL"));
    assertEquals(ValidatorResult.FAIL, ValidatorResult.from("false"));

    assertEquals(ValidatorResult.UNKNOWN, ValidatorResult.from("unknown"));
    assertEquals(ValidatorResult.UNKNOWN, ValidatorResult.from("random"));
    assertEquals(ValidatorResult.UNKNOWN, ValidatorResult.from((String) null));
  }
}
