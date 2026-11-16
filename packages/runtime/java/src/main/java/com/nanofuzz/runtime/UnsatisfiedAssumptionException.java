package com.nanofuzz.runtime;

/**
 * Unchecked exception thrown when an assumption in an input transformer is not
 * satisfied.
 * Signals to NaNofuzz that the candidate input should be filtered out /
 * skipped.
 */
public class UnsatisfiedAssumptionException extends RuntimeException {

  public UnsatisfiedAssumptionException(String message) {
    super(message != null ? message : "Unsatisfied assumption");
  }

  public UnsatisfiedAssumptionException() {
    super("Unsatisfied assumption");
  }
}
