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

let manifest : (int * string * (int * int) list) list = [
  /* __NANOFUZZ_COVERAGE_MANIFEST__ */
]

let cov_to_json () =
  let map = Coverage.take_multi_hits manifest in
  let assoc = Hashtbl.fold (fun path cov acc ->
    (path, Coverage.file_coverage_to_yojson cov) :: acc
  ) map [] in
  `Assoc assoc

let () =
  set_binary_mode_in stdin true;
  set_binary_mode_out stdout true;
  Printexc.record_backtrace true;

  (* Send READY handshake message *)
  write_msg stdout "\"READY\"";

  (* Send initial static coverage metadata *)
  let static_cov_json = {|/* __NANOFUZZ_STATIC_COV_JSON__ */|} in
  write_msg stdout static_cov_json;

  let rec loop () =
    match read_msg stdin with
    | None -> ()
    | Some payload ->
      let json =
        try Yojson.Safe.from_string payload
        with Yojson.Json_error msg ->
          let err_resp = `Assoc [
            ("tag", `String "error");
            ("name", `String "PayloadDeserializationError");
            ("message", `String ("Failed to parse payload: " ^ msg));
            ("source", `String "put");
            ("seq", `Int (-1));
          ] in
          write_msg stdout (Yojson.Safe.to_string err_resp);
          `Null
      in
      if json <> `Null then begin
        let seq =
          match json with
          | `Assoc fields ->
            (match List.assoc_opt "seq" fields with
             | Some (`Int s) -> s
             | _ -> 0)
          | _ -> 0
        in
        let args =
          match json with
          | `Assoc fields ->
            (match List.assoc_opt "args" fields with
             | Some (`List l) -> l
             | _ -> [])
          | _ -> []
        in
        let validators =
          match json with
          | `Assoc fields ->
            (match List.assoc_opt "validators" fields with
             | Some (`List l) ->
               List.filter_map (function `String s -> Some s | _ -> None) l
             | _ -> [])
          | _ -> []
        in

        Coverage.reset ();

        (* Argument Conversions *)
        let deser_res =
          try
            /* __NANOFUZZ_ARG_CONVERSIONS__ */
            Ok (/* __NANOFUZZ_CALL_ARGS__ */)
          with
          | Failure msg -> Error ("Argument deserialization error: " ^ msg)
          | exn -> Error ("Argument deserialization error: " ^ Printexc.to_string exn)
        in

        match deser_res with
        | Error msg ->
          let resp = `Assoc [
            ("tag", `String "error");
            ("name", `String "DeserializationError");
            ("message", `String msg);
            ("source", `String "put");
            ("seq", `Int seq);
            ("coverageData", cov_to_json ());
          ] in
          write_msg stdout (Yojson.Safe.to_string resp);
          loop ()
        | Ok (/* __NANOFUZZ_CALL_ARGS_PAT__ */) ->
          let call_res =
            try
              /* __NANOFUZZ_FN_CALL__ */
            with
            | Unsatisfied_assumption msg -> Error (`Skip msg)
            | exn ->
              let bt = Printexc.get_backtrace () in
              Error (`Exn (Printexc.to_string exn, bt))
          in

          let response =
            match call_res with
            | Error (`Skip msg) ->
              `Assoc [
                ("tag", `String "skip");
                ("message", `String msg);
                ("seq", `Int seq);
                ("coverageData", cov_to_json ());
              ]
            | Error (`Exn (msg, bt)) ->
              `Assoc [
                ("tag", `String "error");
                ("name", `String "Exception");
                ("message", `String msg);
                ("stack", `String bt);
                ("source", `String "put");
                ("seq", `Int seq);
                ("coverageData", cov_to_json ());
              ]
            | Ok out_json ->
              let val_results = ref [] in
              /* __NANOFUZZ_VALIDATORS__ */
              let val_assoc =
                if !val_results = [] then []
                else [ ("validators", `Assoc !val_results) ]
              in
              `Assoc ([
                ("tag", `String "value");
                ("value", out_json);
                ("seq", `Int seq);
                ("coverageData", cov_to_json ());
              ] @ val_assoc)
          in

          write_msg stdout (Yojson.Safe.to_string response);
          loop ()
      end
  in
  loop ()
