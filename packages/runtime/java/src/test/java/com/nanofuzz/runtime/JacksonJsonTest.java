package com.nanofuzz.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

public class JacksonJsonTest {

  @Test
  void testJacksonJsonSerializationAndDeserialization() throws Exception {
    ObjectMapper mapper = new ObjectMapper();

    Map<String, Object> req = Map.of(
        "seq", 42L,
        "fnName", "add",
        "args", List.of(10, 20));

    byte[] bytes = mapper.writeValueAsBytes(req);
    assertNotNull(bytes);
    assertTrue(bytes.length > 0);

    @SuppressWarnings("unchecked")
    Map<String, Object> decoded = mapper.readValue(bytes, Map.class);
    assertEquals(42, ((Number) decoded.get("seq")).intValue());
    assertEquals("add", decoded.get("fnName"));
    assertEquals(List.of(10, 20), decoded.get("args"));
  }
}
