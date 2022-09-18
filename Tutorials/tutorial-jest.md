# Tutorial: Jest

Jest is a useful tool for quickly unit testing Typescript programs.

## How to use Jest:

1. Define your unit tests in a `*.test.ts` file
2. Click the `Run` button above any test in the `*.test.ts` file.
3. Inspect the results

We will walk through each step in the tutorial below.

## Reading a Jest unit test

Please examine the Jest unit test below.

```Typescript
Run|Debug
test("gcd test", () => { // Name of test
  expect(
    gcd(100,10) // Call gcd w/inputs 100 and 10
  ).toStrictEqual(10); // Expect the output to equal 10
});
```

Can you find the key parts of the test?

1. The Jest unit test is named `gcd test`.
2. This test calls function `gcd()` with inputs `100` and `10`.
3. If the output of `gcd(100,10)` is `10`, then the unit test `PASS`es; otherwise, it `FAIL`s.

All Jest unit tests follow a similar pattern to the above.

## The function we are testing

The source code for `gcd()` may be found in `tutorial.ts` within the same `tutorials` folder. It looks like this?

```Typescript
function gcd(a:number, b:number):number {
  if (b === 0)
    return a;
  else
    return gcd(b, (a % b));
}
```

## Exercise 1

Open the `tutorial.test.ts` file in this tutorial folder.

Click the `Run` button above any test to automatically run it. The test will run in the terminal window.

In the terminal window, did the test `PASS` or `FAIL`?

## Exercise 2

Open the `tutorial.test.ts` file in this same `tutorials` folder.

Create a new unit test that `PASS`es when `gcd(75,25)` outputs `25`.

> **Tip**: You can copy and paste Jest tests. Then change the name, input, and output values to make a new test. It's that simple!

The test you created should look similar to:

```Typescript
Run|Debug
test("gcd test c", () => {
  expect(
    gcd(75, 25)
  ).toStrictEqual(25);
});
```

Now click the `Run` button to run the test.

In the terminal window, did the test `PASS` or `FAIL`?

## Conclusion

Creating new Jest unit tests is as simple as copying and pasting then changing the values and names in the new test. Then click `Run`. That's it!

> **Tip**: You can copy and paste Jest tests. Then change the name, input, and output values to make a new test. It's that simple!

There are many advanced Jest features you may explore in the Jest documentation, but what you have learned is all you need for the tasks we will be performing today.
