package com.nanofuzz.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Result of a single fuzzer execution passed to property validator functions.
 */
public class FuzzTestResult {

  private final List<Object> in;
  private final Object out;
  private final boolean exception;
  private final boolean timeout;

  /**
   * Constructs a new FuzzTestResult instance.
   *
   * @param in        Ordered list of input arguments passed to the function under
   *                  test
   * @param out       Return value produced by the function under test
   * @param exception True if the function under test threw an uncaught exception
   * @param timeout   True if the function execution exceeded the allocated
   *                  timeout
   */
  public FuzzTestResult(
      List<Object> in,
      Object out,
      boolean exception,
      boolean timeout) {
    this.in = in != null
        ? Collections.unmodifiableList(new ArrayList<>(in))
        : Collections.emptyList();
    this.out = out;
    this.exception = exception;
    this.timeout = timeout;
  }

  /**
   * Gets the argument at the specified index, casting to the expected return
   * type.
   *
   * @param <T>   Expected return type
   * @param index 0-based argument index
   * @return Typed argument value
   */
  @SuppressWarnings("unchecked")
  public <T> T getIn(int index) {
    if (index < 0 || index >= in.size()) {
      throw new IndexOutOfBoundsException(
          "Input argument index " + index + " out of bounds (len: " + in.size() + ")");
    }
    return (T) in.get(index);
  }

  /**
   * Gets the function return value, casting to the expected return type.
   *
   * @param <T> Expected return type
   * @return Typed output value
   */
  @SuppressWarnings("unchecked")
  public <T> T getOut() {
    return (T) out;
  }

  /**
   * Returns all input arguments.
   *
   * @return Unmodifiable list of input arguments
   */
  public List<Object> getInputs() {
    return in;
  }

  /**
   * Returns all input arguments (alias for getInputs).
   *
   * @return Unmodifiable list of input arguments
   */
  public List<Object> inputs() {
    return in;
  }

  /**
   * Returns all input arguments (alias for getInputs).
   *
   * @return Unmodifiable list of input arguments
   */
  public List<Object> in() {
    return in;
  }

  /**
   * Returns the function output value.
   *
   * @return Output value or null
   */
  public Object getOutput() {
    return out;
  }

  /**
   * Returns the function output value (alias for getOutput).
   *
   * @return Output value or null
   */
  public Object out() {
    return out;
  }

  /**
   * Returns true if the function threw an uncaught exception.
   *
   * @return True if exception thrown
   */
  public boolean isException() {
    return exception;
  }

  /**
   * Returns true if the function threw an uncaught exception (alias for
   * isException).
   *
   * @return True if exception thrown
   */
  public boolean exception() {
    return exception;
  }

  /**
   * Returns true if the function call timed out.
   *
   * @return True if timed out
   */
  public boolean isTimeout() {
    return timeout;
  }

  /**
   * Returns true if the function call timed out (alias for isTimeout).
   *
   * @return True if timed out
   */
  public boolean timeout() {
    return timeout;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (o == null || getClass() != o.getClass()) {
      return false;
    }
    FuzzTestResult that = (FuzzTestResult) o;
    return exception == that.exception
        && timeout == that.timeout
        && Objects.equals(in, that.in)
        && Objects.equals(out, that.out);
  }

  @Override
  public int hashCode() {
    return Objects.hash(in, out, exception, timeout);
  }

  @Override
  public String toString() {
    return "FuzzTestResult{"
        + "in=" + in
        + ", out=" + out
        + ", exception=" + exception
        + ", timeout=" + timeout
        + '}';
  }
}
