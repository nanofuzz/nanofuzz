package testfixtures

import (
	"fmt"
	"strings"
	"time"

	"github.com/nanofuzz/runtime"
)

// Greeting greets someone.
func Greeting(name string) string {
	return fmt.Sprintf("Hello %s", name)
}

// GreetingValidator validates Greeting output.
func GreetingValidator(r runtime.FuzzTestResult) runtime.ValidatorResult {
	out, ok1 := r.Out.(string)
	name, ok2 := r.In[0].(string)
	if ok1 && ok2 && strings.HasSuffix(out, name) {
		return runtime.Pass
	}
	return runtime.Fail
}

// Throws panics if n > 10.
func Throws(n int) int {
	if n > 10 {
		panic("input greater than 10 not allowed")
	}
	return n
}

// Timeouts loops infinitely if n > 0.
func Timeouts(n int) int {
	if n > 0 {
		for {
			time.Sleep(10 * time.Millisecond)
		}
	}
	return n
}

// WithAssume demonstrates assume filtering.
func WithAssume(n int) int {
	runtime.Assume(n != 5, "n cannot be 5")
	return n
}

// Transformed adds 1 to n.
func Transformed(n int) int {
	return n + 1
}

// TransformedTransformer scales n by 10 and filters n == 5 and non-positive numbers.
func TransformedTransformer(n int) int {
	runtime.Assume(n > 0 && n != 5, "Transformer skipped non-positive or n=5")
	return n * 10
}

// UserGen combines string and int.
func UserGen(n int, s string) string {
	return fmt.Sprintf("%s:%d", s, n)
}

// UserGenGenerator generates custom inputs.
func UserGenGenerator(prng func() float64) (int, string, bool) {
	n := int(prng() * 100.0)
	return n, "custom", true
}
