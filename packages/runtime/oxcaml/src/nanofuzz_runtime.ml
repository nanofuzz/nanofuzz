let version = "0.4.1"

type fuzz_test_result = {
  inputs : Yojson.Safe.t list;
  out : Yojson.Safe.t;
  exception_ : bool;
  timeout : bool;
}

let make_fuzz_test_result ~inputs ~out ~exception_ ~timeout =
  { inputs; out; exception_; timeout }

let get_in idx res =
  if idx >= 0 && idx < List.length res.inputs then
    Some (List.nth res.inputs idx)
  else
    None

let get_out res = res.out

let fuzz_test_result_to_yojson res =
  `Assoc [
    ("in", `List res.inputs);
    ("out", res.out);
    ("exception", `Bool res.exception_);
    ("timeout", `Bool res.timeout);
  ]

let fuzz_test_result_of_yojson = function
  | `Assoc fields ->
    let inputs =
      match List.assoc_opt "in" fields with
      | Some (`List l) -> Ok l
      | Some _ -> Error "'in' must be a list"
      | None -> Ok []
    in
    let out =
      match List.assoc_opt "out" fields with
      | Some v -> Ok v
      | None -> Ok `Null
    in
    let exception_ =
      match List.assoc_opt "exception" fields with
      | Some (`Bool b) -> Ok b
      | Some _ -> Error "'exception' must be a boolean"
      | None -> Ok false
    in
    let timeout =
      match List.assoc_opt "timeout" fields with
      | Some (`Bool b) -> Ok b
      | Some _ -> Error "'timeout' must be a boolean"
      | None -> Ok false
    in
    (match (inputs, out, exception_, timeout) with
     | Ok inputs, Ok out, Ok exception_, Ok timeout ->
       Ok { inputs; out; exception_; timeout }
     | Error e, _, _, _
     | _, Error e, _, _
     | _, _, Error e, _
     | _, _, _, Error e -> Error e)
  | _ -> Error "Expected an object for fuzz_test_result"

let fuzz_test_result_to_json_string res =
  Yojson.Safe.to_string (fuzz_test_result_to_yojson res)

let fuzz_test_result_of_json_string str =
  try
    let json = Yojson.Safe.from_string str in
    fuzz_test_result_of_yojson json
  with Yojson.Json_error msg -> Error msg

type validator_result =
  | Pass
  | Fail
  | Unknown

let validator_result_to_string = function
  | Pass -> "pass"
  | Fail -> "fail"
  | Unknown -> "unknown"

let validator_result_of_string = function
  | "pass" -> Pass
  | "fail" -> Fail
  | _ -> Unknown

let validator_result_of_bool = function
  | true -> Pass
  | false -> Fail

exception Unsatisfied_assumption of string

let assume ?(message = "Unsatisfied assumption") condition =
  if not condition then raise (Unsatisfied_assumption message)

exception Assertion_failure of string

let assert_true ?(message = "Assertion failed") condition =
  if not condition then raise (Assertion_failure message)

let assert_equal ?(message = "Values are not equal") a b =
  if a <> b then raise (Assertion_failure message)

let assert_eq = assert_equal

let rec msgpck_to_yojson : Msgpck.t -> Yojson.Safe.t = function
  | Nil -> `Null
  | Bool b -> `Bool b
  | Int n -> `Int n
  | Int32 n -> `Int (Int32.to_int n)
  | Int64 n -> `Intlit (Int64.to_string n)
  | Uint32 n -> `Int (Int32.to_int n)
  | Uint64 n -> `Intlit (Int64.to_string n)
  | Float f -> `Float f
  | Float32 f -> `Float (Int32.float_of_bits f)
  | String s -> `String s
  | Bytes s -> `String s
  | Ext (_, s) -> `String s
  | List l -> `List (List.map msgpck_to_yojson l)
  | Map m ->
    (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____BIGINT____") m with
     | Some (_, Msgpck.String s) -> `Intlit s
     | _ ->
       let assoc =
         List.map
           (fun (k, v) ->
             let key =
               match k with
               | Msgpck.String s -> s
               | _ -> Msgpck.show k
             in
             (key, msgpck_to_yojson v))
           m
       in
       `Assoc assoc)

let rec implicit_oracle_value (v : Yojson.Safe.t) : bool =
  match v with
  | `Null -> false
  | `Float f ->
    (match classify_float f with
     | FP_nan | FP_infinite -> false
     | _ -> true)
  | `List l -> List.for_all implicit_oracle_value l
  | `Assoc pairs -> List.for_all (fun (_, v) -> implicit_oracle_value v) pairs
  | _ -> true

module Coverage = struct
  type file_coverage = {
    path : string;
    s : (string, int) Hashtbl.t;
    f : (string, int) Hashtbl.t;
    b : (string, int list) Hashtbl.t;
  }

  let hit_stmts : (int * int) list ref = ref []
  let hit_fns : (int * int) list ref = ref []
  let hit_branches : (int * int * int) list ref = ref []

  let hit_stmt file_id id =
    hit_stmts := (file_id, id) :: !hit_stmts

  let hit_fn file_id id =
    hit_fns := (file_id, id) :: !hit_fns

  let hit_branch file_id branch_id arm_id =
    hit_branches := (file_id, branch_id, arm_id) :: !hit_branches

  let reset () =
    hit_stmts := [];
    hit_fns := [];
    hit_branches := []

  let take_multi_hits manifest =
    let stmts = !hit_stmts in
    let fns = !hit_fns in
    let branches = !hit_branches in
    reset ();

    let stmts_by_file = Hashtbl.create 16 in
    List.iter
      (fun (fid, sid) ->
        let tbl =
          match Hashtbl.find_opt stmts_by_file fid with
          | Some t -> t
          | None ->
            let t = Hashtbl.create 16 in
            Hashtbl.add stmts_by_file fid t;
            t
        in
        let key = string_of_int sid in
        let cur = Option.value (Hashtbl.find_opt tbl key) ~default:0 in
        Hashtbl.replace tbl key (cur + 1))
      stmts;

    let fns_by_file = Hashtbl.create 16 in
    List.iter
      (fun (fid, fnid) ->
        let tbl =
          match Hashtbl.find_opt fns_by_file fid with
          | Some t -> t
          | None ->
            let t = Hashtbl.create 16 in
            Hashtbl.add fns_by_file fid t;
            t
        in
        let key = string_of_int fnid in
        let cur = Option.value (Hashtbl.find_opt tbl key) ~default:0 in
        Hashtbl.replace tbl key (cur + 1))
      fns;

    let branches_by_file = Hashtbl.create 16 in
    List.iter
      (fun (fid, bid, arm) ->
        let lst = Option.value (Hashtbl.find_opt branches_by_file fid) ~default:[] in
        Hashtbl.replace branches_by_file fid ((bid, arm) :: lst))
      branches;

    let result = Hashtbl.create 16 in
    List.iter
      (fun (fid, path, branch_arms) ->
        let s =
          Option.value (Hashtbl.find_opt stmts_by_file fid) ~default:(Hashtbl.create 0)
        in
        let f =
          Option.value (Hashtbl.find_opt fns_by_file fid) ~default:(Hashtbl.create 0)
        in
        let b = Hashtbl.create 16 in
        List.iter
          (fun (bid, arm_count) ->
            let init_slots = Array.to_list (Array.make arm_count 0) in
            Hashtbl.add b (string_of_int bid) init_slots)
          branch_arms;

        (match Hashtbl.find_opt branches_by_file fid with
         | None -> ()
         | Some hits ->
           List.iter
             (fun (bid, arm) ->
               let key = string_of_int bid in
               match Hashtbl.find_opt b key with
               | None -> ()
               | Some slots ->
                 let arr = Array.of_list slots in
                 if arm >= 0 && arm < Array.length arr then begin
                   arr.(arm) <- arr.(arm) + 1;
                   Hashtbl.replace b key (Array.to_list arr)
                 end)
             hits);

        Hashtbl.replace result path { path; s; f; b })
      manifest;
    result

  let take_file_hits file_id path branch_arms =
    let map = take_multi_hits [ (file_id, path, branch_arms) ] in
    match Hashtbl.find_opt map path with
    | Some cov -> cov
    | None ->
      { path; s = Hashtbl.create 0; f = Hashtbl.create 0; b = Hashtbl.create 0 }

  let file_coverage_to_yojson (cov : file_coverage) : Yojson.Safe.t =
    let s_assoc =
      Hashtbl.fold (fun k v acc -> (k, `Int v) :: acc) cov.s []
    in
    let f_assoc =
      Hashtbl.fold (fun k v acc -> (k, `Int v) :: acc) cov.f []
    in
    let b_assoc =
      Hashtbl.fold
        (fun k v acc -> (k, `List (List.map (fun count -> `Int count) v)) :: acc)
        cov.b []
    in
    `Assoc [
      ("path", `String cov.path);
      ("s", `Assoc s_assoc);
      ("f", `Assoc f_assoc);
      ("b", `Assoc b_assoc);
    ]

  let file_coverage_to_msgpck (cov : file_coverage) : Msgpck.t =
    let s_map =
      Hashtbl.fold
        (fun k v acc -> (Msgpck.String k, Msgpck.Int v) :: acc)
        cov.s []
    in
    let f_map =
      Hashtbl.fold
        (fun k v acc -> (Msgpck.String k, Msgpck.Int v) :: acc)
        cov.f []
    in
    let b_map =
      Hashtbl.fold
        (fun k v acc ->
          (Msgpck.String k, Msgpck.List (List.map (fun count -> Msgpck.Int count) v)) :: acc)
        cov.b []
    in
    Msgpck.Map [
      (Msgpck.String "path", Msgpck.String cov.path);
      (Msgpck.String "s", Msgpck.Map s_map);
      (Msgpck.String "f", Msgpck.Map f_map);
      (Msgpck.String "b", Msgpck.Map b_map);
    ]
end
