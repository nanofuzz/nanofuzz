export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  value: any; // value of element
};

export type FuzzTestResult = {
  pinned: boolean; // true if the test was pinned (not randomly generated)
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passedImplicit: boolean; // true if output matches oracle; false, otherwise
  passedExplicit?: boolean; // true if actual output matches expected output
  elapsedTime: number; // elapsed time of test
  correct: string; // check, error, question, or none
  expectedOutput?: any; // the correct output if correct icon; an incorrect output if error icon
};
