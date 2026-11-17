// A Choice's Place, read as the module it names.
//
// The column carries Places written in today's form (a module, with the file it was written against as a
// mark) and in the older `file` / `dir` forms. Every reader of the fold gets the module, because that is
// what the injection and the planner compare against; a `file` Place becomes its own parent module with
// that file kept as the mark, and a `dir` Place becomes the same dir as a module.

///|
/// One Place of a Choice: the repo-root relative module, its kind, and the optional marks.
priv struct Place {
  path : String
  kind : PlaceKind
  file : String?
  symbols : Array[String]?
}

///|
/// One rename the landing recorded: from a path to a path, a dir's move carrying its trailing `/`.
priv struct PlaceMove {
  from : String
  to : String
}

///|
/// The module a repo-root relative path belongs to: the file's own parent dir, or `/` at the top.
fn module_of(path : String) -> String {
  match path.rev_find("/") {
    Some(at) => path[:at + 1].to_owned()
    None => "/"
  }
}

///|
/// The marks a Place carries: the symbols only when it names any.
fn optional_strings_of(value : Json) -> Array[String]? {
  match value {
    Json::Array(_) => Some(strings_of(value))
    _ => None
  }
}

///|
fn symbols_kept(symbols : Array[String]?) -> Array[String]? {
  match symbols {
    Some(items) => if items.length() > 0 { Some(items) } else { None }
    None => None
  }
}

///|
/// The Place every reader uses: the module it names, with the file it was written against kept as a mark.
fn canonical_place(place : Place) -> Place {
  let symbols = symbols_kept(place.symbols)
  match place.kind {
    PlaceRoot => { path: "/", kind: PlaceRoot, file: None, symbols, }
    PlaceModule => place
    PlaceFile =>
      {
        path: module_of(place.path),
        kind: PlaceModule,
        file: Some(place.path),
        symbols,
      }
    // the older `dir` kind names the module itself, with no file to mark
    PlaceDir => { path: place.path, kind: PlaceModule, file: None, symbols, }
    OtherPlaceKind(_) =>
      { path: place.path, kind: PlaceModule, file: None, symbols, }
  }
}

///|
/// Every Place a row carries, read as the module it names.
fn places_of(value : Json) -> Array[Place] {
  let out : Array[Place] = []
  for item in array_of(value) {
    let file = trimmed_of(field(item, "file"))
    out.push({
      path: string_of(field(item, "path")),
      kind: place_kind_of(field(item, "kind")),
      file,
      symbols: optional_strings_of(field(item, "symbols")),
    })
  }
  out.map(canonical_place)
}

///|
/// The Place a move carries, or nothing when the move does not touch it.
fn moved_place(place : Place, renamed : PlaceMove) -> Place? {
  let dir_move = renamed.from.has_suffix("/")
  if place.kind == PlaceRoot {
    return None
  }
  match place.file {
    Some(file) => {
      // a Place with a file mark follows the file, and its module follows the file's new parent
      let next = if file == renamed.from {
        Some(renamed.to)
      } else if dir_move && file.has_prefix(renamed.from) {
        Some(
          without_trailing_slash(renamed.to) +
          "/" +
          file[renamed.from.length():].to_owned(),
        )
      } else {
        None
      }
      match next {
        None => None
        Some(path) =>
          Some({
            path: module_of(path),
            kind: place.kind,
            file: Some(path),
            symbols: place.symbols,
          })
      }
    }
    None => {
      // a module with no file mark is a dir's own Choice: only a dir that moved carries it
      if !dir_move {
        return None
      }
      let to = if renamed.to.has_suffix("/") {
        renamed.to
      } else {
        renamed.to + "/"
      }
      if place.path == renamed.from {
        Some({ path: to, kind: place.kind, file: None, symbols: place.symbols, })
      } else if place.path.has_prefix(renamed.from) {
        Some({
          path: to + place.path[renamed.from.length():].to_owned(),
          kind: place.kind,
          file: None,
          symbols: place.symbols,
        })
      } else {
        None
      }
    }
  }
}

///|
/// The last `/` kept as the dir's own ending.
fn without_trailing_slash(path : String) -> String {
  match path.strip_suffix("/") {
    Some(body) => body.to_owned()
    None => path
  }
}

///|
/// The Place list with every move that touches it applied; nothing when no move touches it.
fn moved_places(
  places : Array[Place],
  moves : Array[PlaceMove],
) -> Array[Place]? {
  let out : Array[Place] = []
  let mut changed = false
  for place in places {
    let mut current = place
    for renamed in moves {
      match moved_place(current, renamed) {
        Some(moved) => {
          current = moved
          changed = true
        }
        None => ()
      }
    }
    out.push(current)
  }
  if changed {
    Some(out)
  } else {
    None
  }
}
