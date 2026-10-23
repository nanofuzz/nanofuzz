/* Top-level header block comment
 * NaNofuzz test fixtures for Java
 */

// Module-level import comment
import /* inline in import */ java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Optional;

/**
 * NaNofuzz test fixtures for Java.
 */
class FuzzerTestFixtures {

  // Line comment before greeting method
  public /* inline between public and static */ static /* inline between static and return type */ String greeting(
      // Parameter comment
      /* inline before param type */ String /* inline between type and name */ name // trailing param comment
  ) /* inline after params */ {
    // Single line comment inside body
    /* Block comment inside body */
    return /* inline return comment */ "Hello " + name; // trailing comment
  }

  /*
   * Validator function with doc and block comments
   */
  public static String greetingValidator(/* argument comment */ Object /* inline type */ r) {
    // Extract output
    /* inline start */ String out = "pass"; /* inline end */
    return out;
  }

  /**
   * Method that throws exception on input > 10.
   */
  public static int throwsException(/* inline arg */ int /* inline type */ n) {
    /* check if greater than 10 */
    if (n > /* inline condition */ 10) {
      // Throw branch
      throw new IllegalArgumentException("input greater than 10 not allowed");
    }
    // Return expression
    return n;
  }

  /**
   * Method with loop.
   */
  public static int loopMethod(int n) {
    /* init sum */
    int sum = 0;
    for (int i = 0; /* inline loop condition */ i < n; i++) {
      // Loop body
      sum += i;
    }
    return sum;
  }

  /**
   * Primitive number types processor.
   */
  public static void processPrimitives(
      byte /* inline */ b,
      short /* inline */ s,
      int /* inline */ i,
      long /* inline */ l,
      float /* inline */ f,
      double /* inline */ d,
      boolean /* inline */ bool,
      char /* inline */ c) {
  }

  /**
   * Collections and arrays processor.
   */
  public static int processCollections(
      String /* inline */ [] strArray,
      int /* inline */ [][] matrix,
      byte /* inline */ [] rawBytes,
      List<String> /* inline */ list,
      Set<Integer> /* inline */ set,
      Map<String, Double> /* inline */ map,
      Optional<String> /* inline */ maybeStr) {
    return 0;
  }

  /**
   * Transformed test target.
   */
  public static int javaTransformed(int n) {
    // Simple add
    return n + 1;
  }

  public static int[] javaTransformedTransformer(int n) {
    // Transformer computation
    return new int[] { /* inline array element */ n * 10 };
  }
}
