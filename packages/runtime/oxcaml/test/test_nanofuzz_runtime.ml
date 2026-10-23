open OUnit2

let test_version _ =
  assert_equal "0.4.0" Nanofuzz_runtime.version ~printer:(fun s -> s)

let test_fuzz_test_result_accessors _ =
  let inputs = [ `Int 42; `String "hello"; `List [ `Int 1; `Int 2; `Int 3 ] ] in
  let out = `Float 84.5 in
  let ftr = Nanofuzz_runtime.make_fuzz_test_result ~inputs ~out ~exception_:false ~timeout:false in

  assert_equal (Some (`Int 42)) (Nanofuzz_runtime.get_in 0 ftr);
  assert_equal (Some (`String "hello")) (Nanofuzz_runtime.get_in 1 ftr);
  assert_equal None (Nanofuzz_runtime.get_in 99 ftr);
  assert_equal (`Float 84.5) (Nanofuzz_runtime.get_out ftr);
  assert_equal false ftr.exception_;
  assert_equal false ftr.timeout

let test_fuzz_test_result_serde_roundtrip _ =
  let raw_json =
    {|{"in":[10,"test"],"out":true,"exception":false,"timeout":false}|}
  in
  match Nanofuzz_runtime.fuzz_test_result_of_json_string raw_json with
  | Error msg -> assert_failure ("Failed to parse JSON: " ^ msg)
  | Ok ftr ->
    assert_equal (Some (`Int 10)) (Nanofuzz_runtime.get_in 0 ftr);
    assert_equal (Some (`String "test")) (Nanofuzz_runtime.get_in 1 ftr);
    assert_equal (`Bool true) (Nanofuzz_runtime.get_out ftr);
    let serialized = Nanofuzz_runtime.fuzz_test_result_to_json_string ftr in
    assert_bool "contains in" (String.length serialized > 0);
    (match Nanofuzz_runtime.fuzz_test_result_of_json_string serialized with
     | Error msg -> assert_failure ("Failed to roundtrip: " ^ msg)
     | Ok ftr2 ->
       assert_equal ftr.inputs ftr2.inputs;
       assert_equal ftr.out ftr2.out;
       assert_equal ftr.exception_ ftr2.exception_;
       assert_equal ftr.timeout ftr2.timeout)

let test_validator_result _ =
  assert_equal "pass" (Nanofuzz_runtime.validator_result_to_string Pass);
  assert_equal "fail" (Nanofuzz_runtime.validator_result_to_string Fail);
  assert_equal "unknown" (Nanofuzz_runtime.validator_result_to_string Unknown);

  assert_equal Nanofuzz_runtime.Pass (Nanofuzz_runtime.validator_result_of_bool true);
  assert_equal Nanofuzz_runtime.Fail (Nanofuzz_runtime.validator_result_of_bool false);

  assert_equal Nanofuzz_runtime.Pass (Nanofuzz_runtime.validator_result_of_string "pass");
  assert_equal Nanofuzz_runtime.Fail (Nanofuzz_runtime.validator_result_of_string "fail");
  assert_equal Nanofuzz_runtime.Unknown (Nanofuzz_runtime.validator_result_of_string "other")

let test_assume _ =
  (* Truthy condition should not raise *)
  Nanofuzz_runtime.assume true;
  Nanofuzz_runtime.assume ~message:"should not fail" (1 > 0);

  (* Falsy condition should raise Unsatisfied_assumption *)
  let raised_default =
    try
      Nanofuzz_runtime.assume false;
      false
    with Nanofuzz_runtime.Unsatisfied_assumption msg ->
      assert_equal "Unsatisfied assumption" msg;
      true
  in
  assert_bool "Default message raised" raised_default;

  let raised_custom =
    try
      Nanofuzz_runtime.assume ~message:"n must be positive" (0 > 1);
      false
    with Nanofuzz_runtime.Unsatisfied_assumption msg ->
      assert_equal "n must be positive" msg;
      true
  in
  assert_bool "Custom message raised" raised_custom

let test_assert _ =
  Nanofuzz_runtime.assert_true true;
  Nanofuzz_runtime.assert_true ~message:"should not fail" (2 > 1);
  Nanofuzz_runtime.assert_equal 42 42;
  Nanofuzz_runtime.assert_eq ~message:"strings match" "hello" "hello";

  let raised_true =
    try
      Nanofuzz_runtime.assert_true false;
      false
    with Nanofuzz_runtime.Assertion_failure msg ->
      assert_equal "Assertion failed" msg;
      true
  in
  assert_bool "assert_true failed properly" raised_true;

  let raised_equal =
    try
      Nanofuzz_runtime.assert_equal ~message:"mismatch" 1 2;
      false
    with Nanofuzz_runtime.Assertion_failure msg ->
      assert_equal "mismatch" msg;
      true
  in
  assert_bool "assert_equal failed properly" raised_equal

let test_implicit_oracle _ =
  assert_equal true (Nanofuzz_runtime.implicit_oracle_value (`Int 42));
  assert_equal true (Nanofuzz_runtime.implicit_oracle_value (`String "hello"));
  assert_equal true (Nanofuzz_runtime.implicit_oracle_value (`List [ `Int 1; `Int 2 ]));

  assert_equal false (Nanofuzz_runtime.implicit_oracle_value `Null);
  assert_equal false (Nanofuzz_runtime.implicit_oracle_value (`Float nan));
  assert_equal false (Nanofuzz_runtime.implicit_oracle_value (`Float infinity));
  assert_equal false (Nanofuzz_runtime.implicit_oracle_value (`Float neg_infinity));
  assert_equal false (Nanofuzz_runtime.implicit_oracle_value (`List [ `Int 1; `Null ]))

let test_coverage _ =
  Nanofuzz_runtime.Coverage.reset ();
  Nanofuzz_runtime.Coverage.hit_fn 0 1;
  Nanofuzz_runtime.Coverage.hit_stmt 0 10;
  Nanofuzz_runtime.Coverage.hit_stmt 0 10;
  Nanofuzz_runtime.Coverage.hit_branch 0 2 0;

  let file_cov = Nanofuzz_runtime.Coverage.take_file_hits 0 "foo.ml" [ (2, 2) ] in
  assert_equal "foo.ml" file_cov.path;
  assert_equal (Some 1) (Hashtbl.find_opt file_cov.f "1");
  assert_equal (Some 2) (Hashtbl.find_opt file_cov.s "10");
  assert_equal (Some [ 1; 0 ]) (Hashtbl.find_opt file_cov.b "2")

let suite =
  "Nanofuzz_runtime_tests"
  >::: [
         "test_version" >:: test_version;
         "test_fuzz_test_result_accessors" >:: test_fuzz_test_result_accessors;
         "test_fuzz_test_result_serde_roundtrip" >:: test_fuzz_test_result_serde_roundtrip;
         "test_validator_result" >:: test_validator_result;
         "test_assume" >:: test_assume;
         "test_assert" >:: test_assert;
         "test_implicit_oracle" >:: test_implicit_oracle;
         "test_coverage" >:: test_coverage;
       ]

let () = run_test_tt_main suite
