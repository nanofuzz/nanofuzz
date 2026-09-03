import * as ProgramFactory from "../ProgramFactory";
import { ArgDefGenerator } from "../ArgDefGenerator";
import { ArgDefValidator } from "../ArgDefValidator";
import * as Parser from "../../adapters/ParserAdapter";
import seedrandom from "seedrandom";

describe("fuzzer/analysis/python/PythonProgram Hypothesis Alphabet Round-Trip & Domain Coverage Tests", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  const seed = "hypothesis-roundtrip-seed";

  it("extracts @given parameters, generates inputs, and verifies they satisfy constraints", () => {
    const pythonCode = `
import string
from hypothesis import strategies as st

@given(
  a1=st.text(alphabet=st.characters(whitelist_categories=("L", "N")), min_size=1, max_size=10),
  a2=st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=10),
  a3=st.text(alphabet=st.characters(whitelist_categories=("L", "N", "P", "S", "Z"), blacklist_characters="'\\\\"), min_size=1, max_size=10),
  a4=st.text(alphabet=st.characters(whitelist_categories=("L", "N"), blacklist_characters='"\\\\'), min_size=1, max_size=10),
  a5=st.text(alphabet=st.characters(whitelist_categories=('L', 'N', 'Zs'), whitelist_characters=' '), min_size=1, max_size=10),
  a6=st.text(alphabet=st.sampled_from("aäöüéèêëàâîïôûçñ"), min_size=1, max_size=10),
  a7=st.text(alphabet=st.characters(min_codepoint=0x1F600, max_codepoint=0x1F64F), min_size=1, max_size=5),
  a8=st.text(alphabet=string.ascii_letters + string.digits, min_size=1, max_size=10),
  a9=st.text(alphabet=st.characters(min_codepoint=32, max_codepoint=126), min_size=1, max_size=10)
)
def test_all_alphabets(a1, a2, a3, a4, a5, a6, a7, a8, a9):
  pass
`;

    const program = ProgramFactory.fromSource(() => pythonCode, "python");
    const fn = program.functionsExported["test_all_alphabets"];
    expect(fn).toBeDefined();

    const argDefs = fn.getArgDefs();
    expect(argDefs.length).toEqual(9);

    const prng = seedrandom(seed);
    const generator = new ArgDefGenerator(argDefs, prng);

    const numSamples = 200;
    for (let i = 0; i < numSamples; i++) {
      const inputs = generator.next();
      expect(inputs.length).toEqual(9);

      for (let j = 0; j < inputs.length; j++) {
        const argDef = argDefs[j];
        const val = inputs[j].value;

        // 1. Must be a string
        expect(typeof val).toEqual("string");

        // 2. ArgDefValidator round-trip check
        expect(ArgDefValidator.validate(val, argDef)).toBeTrue();

        // 3. Length bound check
        if (typeof val === "string") {
          const len = Array.from(val).length;
          expect(len).toBeGreaterThanOrEqual(argDef.getOptions().strLength.min);
          expect(len).toBeLessThanOrEqual(argDef.getOptions().strLength.max);
        }
      }
    }
  });

  describe("Permutation & Domain Coverage", () => {
    it("generates 100% of possible permutations for a small finite domain", () => {
      const pythonCode = `
from hypothesis import strategies as st

@given(s=st.text(alphabet=st.sampled_from("abc"), min_size=2, max_size=2))
def test_finite_permutations(s):
  pass
`;

      const program = ProgramFactory.fromSource(() => pythonCode, "python");
      const fn = program.functionsExported["test_finite_permutations"];
      const argDefs = fn.getArgDefs();

      const prng = seedrandom(seed);
      const generator = new ArgDefGenerator(argDefs, prng);

      // Total expected permutations: 3^2 = 9 ("aa", "ab", "ac", "ba", "bb", "bc", "ca", "cb", "cc")
      const expectedPermutations = new Set([
        "aa",
        "ab",
        "ac",
        "ba",
        "bb",
        "bc",
        "ca",
        "cb",
        "cc",
      ]);

      const observedPermutations = new Set<string>();
      const numSamples = 500;

      for (let i = 0; i < numSamples; i++) {
        const inputs = generator.next();
        const val = inputs[0].value;
        if (typeof val === "string") {
          observedPermutations.add(val);
        }
      }

      expect(observedPermutations.size).toEqual(expectedPermutations.size);
      for (const expected of expectedPermutations) {
        expect(observedPermutations.has(expected)).toBeTrue();
      }
    });

    it("achieves 100% character set (alphabet) coverage over sampled iterations", () => {
      const pythonCode = `
from hypothesis import strategies as st

@given(s=st.text(alphabet=st.sampled_from("aäöüéèêëàâîïôûçñ"), min_size=1, max_size=5))
def test_alphabet_coverage(s):
  pass
`;

      const program = ProgramFactory.fromSource(() => pythonCode, "python");
      const fn = program.functionsExported["test_alphabet_coverage"];
      const argDefs = fn.getArgDefs();

      const prng = seedrandom(seed);
      const generator = new ArgDefGenerator(argDefs, prng);

      const expectedAlphabet = new Set("aäöüéèêëàâîïôûçñ".split(""));
      const observedCharacters = new Set<string>();

      const numSamples = 200;
      for (let i = 0; i < numSamples; i++) {
        const inputs = generator.next();
        const val = inputs[0].value;
        if (typeof val === "string") {
          for (const char of Array.from(val)) {
            observedCharacters.add(char);
          }
        }
      }

      expect(observedCharacters.size).toEqual(expectedAlphabet.size);
      for (const expectedChar of expectedAlphabet) {
        expect(observedCharacters.has(expectedChar)).toBeTrue();
      }
    });

    it("covers the full string length range from min_size to max_size", () => {
      const pythonCode = `
import string
from hypothesis import strategies as st

@given(s=st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=8))
def test_length_range_coverage(s):
  pass
`;

      const program = ProgramFactory.fromSource(() => pythonCode, "python");
      const fn = program.functionsExported["test_length_range_coverage"];
      const argDefs = fn.getArgDefs();

      const prng = seedrandom(seed);
      const generator = new ArgDefGenerator(argDefs, prng);

      const observedLengths = new Set<number>();
      const numSamples = 300;

      for (let i = 0; i < numSamples; i++) {
        const inputs = generator.next();
        const val = inputs[0].value;
        if (typeof val === "string") {
          observedLengths.add(val.length);
        }
      }

      for (let expectedLen = 1; expectedLen <= 8; expectedLen++) {
        expect(observedLengths.has(expectedLen)).toBeTrue();
      }
    });
  });
});
