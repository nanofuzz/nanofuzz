/* Top-level header block comment
 * NaNofuzz test fixtures for Java
 */

// Module-level import comment
import /* inline in import */ java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Optional;
import com.nanofuzz.runtime.FuzzTestResult;
import com.nanofuzz.runtime.Assume;

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
  public static String greetingValidator(/* argument comment */ FuzzTestResult /* inline type */ r) {
    String out = r.getOut();
    if (out != null && out.startsWith("Hello ")) {
      return "pass";
    }
    return "fail";
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
   * Method with timeout.
   */
  public static int timeouts(int n) {
    if (n > 0) {
      try {
        Thread.sleep(10000);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
    return n;
  }

  /**
   * Method with assume precondition.
   */
  public static int withAssume(int n) {
    Assume.that(n != 5, "n cannot be 5");
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

  public static Object[] javaTransformedTransformer(int n) {
    Assume.that(n >= 0 && n != 5, "Transformer skipped negative n or n=5");
    return new Object[] { /* inline array element */ n * 10 };
  }

  /**
   * Custom user input generator target.
   */
  public static String javaUserGen(int n, String s) {
    return s + ":" + n;
  }

  public static Object[] javaUserGenGenerator(java.util.function.DoubleSupplier prng) {
    int n = (int) (prng.getAsDouble() * 100.0);
    return new Object[] { n, "custom" };
  }
}
