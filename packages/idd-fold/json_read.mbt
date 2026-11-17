// Reading a row out of JSON, the way the TypeScript fold reads a row out of a parsed line.
//
// A column's line is a free object: a field may be missing, hold another type, or carry a value an older
// writer wrote. The readers here answer the same questions the TypeScript fold asks (`typeof x === "string"`,
// a trimmed non-empty string, an array) so a row folds the same on both sides.

///|
/// The value under a key, or null when the value is not an object or has no such key.
fn field(value : Json, key : String) -> Json {
  match value {
    Json::Object(fields) =>
      match fields.get(key) {
        Some(found) => found
        None => Json::null()
      }
    _ => Json::null()
  }
}

///|
/// The array a value holds, or an empty one.
fn array_of(value : Json) -> Array[Json] {
  match value {
    Json::Array(items) => items
    _ => []
  }
}

///|
/// The object a value holds, or null.
fn object_of(value : Json) -> Json? {
  match value {
    Json::Object(_) => Some(value)
    _ => None
  }
}

///|
/// The string a value holds, as it is (no trimming), or the empty string.
fn string_of(value : Json) -> String {
  match value {
    Json::String(text) => text
    _ => ""
  }
}

///|
/// `text()` of the TypeScript fold: a trimmed, non-empty string, or nothing.
fn trimmed_of(value : Json) -> String? {
  match value {
    Json::String(text) => {
      let trimmed = text.trim().to_owned()
      if trimmed == "" {
        None
      } else {
        Some(trimmed)
      }
    }
    _ => None
  }
}

///|
/// A number that stands for a whole number, or nothing.
fn int_of(value : Json) -> Int? {
  match value {
    Json::Number(number, ..) =>
      if number.is_nan() || number != number.floor() {
        None
      } else {
        Some(number.to_int())
      }
    _ => None
  }
}

///|
/// The strings an array holds, in the order they are written.
fn strings_of(value : Json) -> Array[String] {
  let out : Array[String] = []
  for item in array_of(value) {
    match item {
      Json::String(text) => out.push(text)
      _ => ()
    }
  }
  out
}

///|
/// An object of the given fields, in the order they are given.
fn json_object(fields : Array[(String, Json)]) -> Json {
  let map : Map[String, Json] = Map([])
  for pair in fields {
    map.set(pair.0, pair.1)
  }
  Json::object(map)
}

///|
/// A key and its value, left out when there is nothing to write (the TypeScript fold leaves the key out too).
fn maybe(key : String, value : String?) -> Array[(String, Json)] {
  match value {
    Some(text) => [(key, Json::string(text))]
    None => []
  }
}
