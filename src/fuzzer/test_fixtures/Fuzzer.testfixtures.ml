(* Top-level header comment
 * NaNofuzz test fixtures for OCaml / OxCaml
 *)

open Nanofuzz_runtime

let greeting (name : string) : string =
  "Hello " ^ name

let greetingValidator (r : Nanofuzz_runtime.fuzz_test_result) : string =
  let name =
    match Nanofuzz_runtime.get_in 0 r with
    | Some (`String s) -> s
    | _ -> ""
  in
  let out_str =
    match Nanofuzz_runtime.get_out r with
    | `String s -> s
    | _ -> ""
  in
  let name_len = String.length name in
  let out_len = String.length out_str in
  if out_len >= name_len && String.sub out_str (out_len - name_len) name_len = name then
    "pass"
  else
    "fail"

let throws (n : int) : int =
  if n > 10 then
    raise (Failure "input greater than 10 not allowed")
  else
    n

let timeouts (n : int) : int =
  if n > 0 then
    let rec loop () = loop () in loop ()
  else
    n

let with_assume (n : int) : int =
  assume ~message:"n cannot be 5" (n <> 5);
  n

let ox_transformed (n : int) : int =
  n + 1

let ox_transformedTransformer (n : int) : int =
  assume ~message:"Transformer skipped negative" (n >= 0);
  n * 10

let ox_user_gen (n : int) (s : string) : string =
  Printf.sprintf "%s:%d" s n

let ox_user_genGenerator (prng : unit -> float) : (int * string) option =
  let n = int_of_float (prng () *. 100.0) in
  Some (n, "custom")

let _unexported_helper (x : int) : int =
  x * 2
