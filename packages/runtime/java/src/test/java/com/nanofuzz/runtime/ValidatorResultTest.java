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

  @Test
  void testFromObject() {
    assertEquals(ValidatorResult.PASS, ValidatorResult.from((Object) ValidatorResult.PASS));
    assertEquals(ValidatorResult.FAIL, ValidatorResult.from((Object) ValidatorResult.FAIL));
    assertEquals(ValidatorResult.PASS, ValidatorResult.from((Object) Boolean.TRUE));
    assertEquals(ValidatorResult.FAIL, ValidatorResult.from((Object) Boolean.FALSE));
    assertEquals(ValidatorResult.PASS, ValidatorResult.from((Object) "pass"));
    assertEquals(ValidatorResult.UNKNOWN, ValidatorResult.from((Object) 123));
    assertEquals(ValidatorResult.UNKNOWN, ValidatorResult.from((Object) null));
  }
}
