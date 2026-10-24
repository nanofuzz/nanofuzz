(** Current version of the nanofuzz_runtime library. *)
val version : string

(** Result of a single fuzzer execution passed to property validator functions. *)
type fuzz_test_result = {
  inputs : Yojson.Safe.t list;
  out : Yojson.Safe.t;
  exception_ : bool;
  timeout : bool;
}

(** Constructs a new [fuzz_test_result]. *)
val make_fuzz_test_result :
  inputs:Yojson.Safe.t list ->
  out:Yojson.Safe.t ->
  exception_:bool ->
  timeout:bool ->
  fuzz_test_result

(** Returns the raw input JSON value at 0-based index [idx], or [None] if out of bounds. *)
val get_in : int -> fuzz_test_result -> Yojson.Safe.t option

(** Returns the return value as a raw JSON value. *)
val get_out : fuzz_test_result -> Yojson.Safe.t

(** Converts a [fuzz_test_result] into its Yojson JSON AST representation.
    Note: the inputs list is encoded with key ["in"] matching NaNofuzz protocol. *)
val fuzz_test_result_to_yojson : fuzz_test_result -> Yojson.Safe.t

(** Decodes a Yojson JSON AST into a [fuzz_test_result]. *)
val fuzz_test_result_of_yojson : Yojson.Safe.t -> (fuzz_test_result, string) result

(** Converts a [fuzz_test_result] into a JSON string. *)
val fuzz_test_result_to_json_string : fuzz_test_result -> string

(** Decodes a JSON string into a [fuzz_test_result]. *)
val fuzz_test_result_of_json_string : string -> (fuzz_test_result, string) result

(** Outcome of a property validator evaluation. *)
type validator_result =
  | Pass
  | Fail
  | Unknown

(** Returns the lowercase string representation ("pass", "fail", or "unknown"). *)
val validator_result_to_string : validator_result -> string

(** Parses a string into a [validator_result]. *)
val validator_result_of_string : string -> validator_result

(** Converts a boolean into [Pass] (if true) or [Fail] (if false). *)
val validator_result_of_bool : bool -> validator_result

(** Exception raised when an assumption in an input transformer is not satisfied. *)
exception Unsatisfied_assumption of string

(** Evaluates [condition]. If true, returns [()]. If false, raises
    [Unsatisfied_assumption msg] to filter out invalid test inputs. *)
val assume : ?message:string -> bool -> unit

(** Exception raised when an assertion in a generated test fails. *)
exception Assertion_failure of string

(** Evaluates [condition]. If true, returns [()]. If false, raises
    [Assertion_failure msg]. Unlike OCaml's built-in [assert], this supports
    custom messages and is never stripped by [-noassert]. *)
val assert_true : ?message:string -> bool -> unit

(** Evaluates structural equality [a = b]. If equal, returns [()].
    If not equal, raises [Assertion_failure msg]. *)
val assert_equal : ?message:string -> 'a -> 'a -> unit

(** Alias for [assert_equal]. *)
val assert_eq : ?message:string -> 'a -> 'a -> unit

(** Converts a Msgpck value into its Yojson.Safe.t equivalent. *)
val msgpck_to_yojson : Msgpck.t -> Yojson.Safe.t

(** Converts a Yojson.Safe.t value into its Msgpck.t equivalent. *)
val yojson_to_msgpck : Yojson.Safe.t -> Msgpck.t

(** Evaluates a Yojson value against the NaNofuzz heuristic / implicit oracle.
    Returns [false] if the value is Null, NaN, or Infinity. *)
val implicit_oracle_value : Yojson.Safe.t -> bool

(** In-process branch, statement, and function coverage tracking module. *)
module Coverage : sig
  type file_coverage = {
    path : string;
    s : (string, int) Hashtbl.t;
    f : (string, int) Hashtbl.t;
    b : (string, int list) Hashtbl.t;
  }

  val hit_stmt : int -> int -> unit
  val hit_fn : int -> int -> unit
  val hit_branch : int -> int -> int -> unit
  val reset : unit -> unit
  val take_file_hits : int -> string -> (int * int) list -> file_coverage
  val take_multi_hits :
    (int * string * (int * int) list) list -> (string, file_coverage) Hashtbl.t
  val file_coverage_to_yojson : file_coverage -> Yojson.Safe.t
  val file_coverage_to_msgpck : file_coverage -> Msgpck.t
end
