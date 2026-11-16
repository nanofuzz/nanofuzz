open Nanofuzz_runtime

let read_exact ic len =
  let buf = Bytes.create len in
  really_input ic buf 0 len;
  Bytes.to_string buf

let read_msg ic =
  let len_bytes = Bytes.create 4 in
  try
    really_input ic len_bytes 0 4;
    let b0 = Char.code (Bytes.get len_bytes 0) in
    let b1 = Char.code (Bytes.get len_bytes 1) in
    let b2 = Char.code (Bytes.get len_bytes 2) in
    let b3 = Char.code (Bytes.get len_bytes 3) in
    let len = (b0 lsl 24) lor (b1 lsl 16) lor (b2 lsl 8) lor b3 in
    Some (read_exact ic len)
  with End_of_file -> None

let write_msg oc msg =
  let len = String.length msg in
  let b0 = Char.chr ((len lsr 24) land 0xFF) in
  let b1 = Char.chr ((len lsr 16) land 0xFF) in
  let b2 = Char.chr ((len lsr 8) land 0xFF) in
  let b3 = Char.chr (len land 0xFF) in
  output_char oc b0;
  output_char oc b1;
  output_char oc b2;
  output_char oc b3;
  output_string oc msg;
  flush oc

let send_msgpck oc (msg : Msgpck.t) =
  let bytes_buf = Msgpck.String.to_string msg in
  write_msg oc (Bytes.to_string bytes_buf)

let manifest : (int * string * (int * int) list) list = [
  /* __NANOFUZZ_COVERAGE_MANIFEST__ */
]

let cov_to_msgpck () : Msgpck.t =
  let map = Coverage.take_multi_hits manifest in
  let assoc = Hashtbl.fold (fun path cov acc ->
    (Msgpck.String path, Coverage.file_coverage_to_msgpck cov) :: acc
  ) map [] in
  Msgpck.Map assoc

let find_key k = function
  | Msgpck.Map l ->
    (match List.find_opt (fun (mk, _) -> mk = Msgpck.String k) l with
     | Some (_, v) -> v
     | None -> Msgpck.Nil)
  | _ -> Msgpck.Nil

let get_int = function
  | Msgpck.Int n -> n
  | Msgpck.Int32 n -> Int32.to_int n
  | Msgpck.Int64 n -> Int64.to_int n
  | Msgpck.Uint32 n -> Int32.to_int n
  | Msgpck.Uint64 n -> Int64.to_int n
  | Msgpck.String s -> (try int_of_string s with _ -> 0)
  | Msgpck.Map m ->
    (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____BIGINT____") m with
     | Some (_, Msgpck.String s) -> (try int_of_string s with _ -> 0)
     | _ -> 0)
  | _ -> 0

let get_int32 = function
  | Msgpck.Int n -> Int32.of_int n
  | Msgpck.Int32 n -> n
  | Msgpck.Int64 n -> Int64.to_int32 n
  | Msgpck.Uint32 n -> n
  | Msgpck.String s -> (try Int32.of_string s with _ -> 0l)
  | Msgpck.Map m ->
    (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____BIGINT____") m with
     | Some (_, Msgpck.String s) -> (try Int32.of_string s with _ -> 0l)
     | _ -> 0l)
  | _ -> 0l

let get_int64 = function
  | Msgpck.Int n -> Int64.of_int n
  | Msgpck.Int64 n -> n
  | Msgpck.Int32 n -> Int64.of_int32 n
  | Msgpck.Uint64 n -> n
  | Msgpck.String s -> (try Int64.of_string s with _ -> 0L)
  | Msgpck.Map m ->
    (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____BIGINT____") m with
     | Some (_, Msgpck.String s) -> (try Int64.of_string s with _ -> 0L)
     | _ -> 0L)
  | _ -> 0L

let get_nativeint = function
  | Msgpck.Int n -> Nativeint.of_int n
  | Msgpck.Int32 n -> Nativeint.of_int32 n
  | Msgpck.Int64 n -> Int64.to_nativeint n
  | Msgpck.String s -> (try Nativeint.of_string s with _ -> 0n)
  | Msgpck.Map m ->
    (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____BIGINT____") m with
     | Some (_, Msgpck.String s) -> (try Nativeint.of_string s with _ -> 0n)
     | _ -> 0n)
  | _ -> 0n

let get_float = function
  | Msgpck.Float f -> f
  | Msgpck.Int n -> float_of_int n
  | Msgpck.Int32 n -> Int32.to_float n
  | Msgpck.Int64 n -> Int64.to_float n
  | _ -> 0.0

let get_bool = function
  | Msgpck.Bool b -> b
  | _ -> false

let get_string = function
  | Msgpck.String s -> s
  | Msgpck.Bytes s -> s
  | _ -> ""

let get_bytes = function
  | Msgpck.Bytes s -> Bytes.of_string s
  | Msgpck.String s -> Bytes.of_string s
  | Msgpck.List l ->
    let b = Bytes.create (List.length l) in
    List.iteri (fun i item -> Bytes.set b i (Char.chr (get_int item land 0xFF))) l;
    b
  | _ -> Bytes.empty

let get_list = function
  | Msgpck.List l -> l
  | _ -> []

let get_map = function
  | Msgpck.Map m -> m
  | _ -> []

let () =
  Random.self_init ();
  set_binary_mode_in stdin true;
  set_binary_mode_out stdout true;
  Printexc.record_backtrace true;

  (* Send READY handshake message *)
  send_msgpck stdout (Msgpck.String "READY");

  (* Send initial static coverage metadata *)
  let static_cov_json = {|/* __NANOFUZZ_STATIC_COV_JSON__ */|} in
  send_msgpck stdout (Msgpck.String static_cov_json);

  let rec loop () =
    match read_msg stdin with
    | None -> ()
    | Some payload ->
      let msg =
        try
          let (_, m) = Msgpck.String.read payload in
          m
        with exn ->
          let err_resp = Msgpck.Map [
            (Msgpck.String "tag", Msgpck.String "error");
            (Msgpck.String "name", Msgpck.String "PayloadDeserializationError");
            (Msgpck.String "message", Msgpck.String ("Failed to parse payload: " ^ Printexc.to_string exn));
            (Msgpck.String "source", Msgpck.String "put");
            (Msgpck.String "seq", Msgpck.Int (-1));
          ] in
          send_msgpck stdout err_resp;
          Msgpck.Nil
      in
      if msg <> Msgpck.Nil then begin
        let seq = get_int (find_key "seq" msg) in
        let args = get_list (find_key "args" msg) in
        let validators =
          match find_key "validators" msg with
          | Msgpck.List l ->
            List.filter_map (function Msgpck.String s -> Some s | _ -> None) l
          | _ -> []
        in

        Coverage.reset ();

        (* Argument Conversions *)
        let deser_res =
          try
            /* __NANOFUZZ_ARG_CONVERSIONS__ */
            Ok (/* __NANOFUZZ_CALL_ARGS__ */)
          with
          | Failure err_msg -> Error ("Argument deserialization error: " ^ err_msg)
          | exn -> Error ("Argument deserialization error: " ^ Printexc.to_string exn)
        in

        match deser_res with
        | Error err_msg ->
          let resp = Msgpck.Map [
            (Msgpck.String "tag", Msgpck.String "error");
            (Msgpck.String "name", Msgpck.String "DeserializationError");
            (Msgpck.String "message", Msgpck.String err_msg);
            (Msgpck.String "source", Msgpck.String "put");
            (Msgpck.String "seq", Msgpck.Int seq);
            (Msgpck.String "coverageData", cov_to_msgpck ());
          ] in
          send_msgpck stdout resp;
          loop ()
        | Ok (/* __NANOFUZZ_CALL_ARGS_PAT__ */) ->
          let call_res =
            try
              /* __NANOFUZZ_FN_CALL__ */
            with
            | Unsatisfied_assumption skip_msg -> Error (`Skip skip_msg)
            | exn ->
              let bt = Printexc.get_backtrace () in
              Error (`Exn (Printexc.to_string exn, bt))
          in

          let response =
            match call_res with
            | Error (`Skip skip_msg) ->
              Msgpck.Map [
                (Msgpck.String "tag", Msgpck.String "skip");
                (Msgpck.String "message", Msgpck.String skip_msg);
                (Msgpck.String "seq", Msgpck.Int seq);
                (Msgpck.String "coverageData", cov_to_msgpck ());
              ]
            | Error (`Exn (exn_msg, bt)) ->
              Msgpck.Map [
                (Msgpck.String "tag", Msgpck.String "error");
                (Msgpck.String "name", Msgpck.String "Exception");
                (Msgpck.String "message", Msgpck.String exn_msg);
                (Msgpck.String "stack", Msgpck.String bt);
                (Msgpck.String "source", Msgpck.String "put");
                (Msgpck.String "seq", Msgpck.Int seq);
                (Msgpck.String "coverageData", cov_to_msgpck ());
              ]
            | Ok out_msgpck ->
              let val_results = ref [] in
              /* __NANOFUZZ_VALIDATORS__ */
              let val_assoc =
                if !val_results = [] then []
                else [ (Msgpck.String "validators", Msgpck.Map !val_results) ]
              in
              Msgpck.Map ([
                (Msgpck.String "tag", Msgpck.String "value");
                (Msgpck.String "value", out_msgpck);
                (Msgpck.String "seq", Msgpck.Int seq);
                (Msgpck.String "coverageData", cov_to_msgpck ());
              ] @ val_assoc)
          in

          send_msgpck stdout response;
          loop ()
      end
  in
  loop ()
