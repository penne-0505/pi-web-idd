// Reading a value out of a row the way the TypeScript derivation reads it.
//
// The lifecycle's `attrs` are an append-only log written by many hands: a field may be missing, hold
// another type, or carry a value an older writer wrote. The TypeScript derivation reads them with the
// language's own rules (`Number(v ?? 0) || 0`, `String(v)`, truthiness, `===`), so the readers here answer
// the same questions. Two of the rules are the host's and are asked of it, as the fold asks `Date.parse`:
// the grammar of `Number(string)` and the rounding of `toFixed(2)`. Everything else is decided here.

///|
/// `Number(text)`: the host's grammar for a numeric string.
extern "js" fn host_number_of_string(text : String) -> Double = "(t) => Number(t)"

///|
/// `n.toFixed(2)`: the host's rounding and rendering.
extern "js" fn host_to_fixed2(number : Double) -> String = "(n) => n.toFixed(2)"

///|
/// The JavaScript truthiness of a value.
fn js_truthy(value : Json) -> Bool {
  match value {
    Json::Null => false
    Json::True => true
    Json::False => false
    Json::Number(number, ..) => number != 0.0 && !number.is_nan()
    Json::String(text) => text.length() > 0
    Json::Array(_) => true
    Json::Object(_) => true
  }
}

///|
/// `String(value)`, for the values a lifecycle row carries.
fn js_string(value : Json) -> String {
  match value {
    Json::Null => "null"
    Json::True => "true"
    Json::False => "false"
    Json::Number(number, ..) => number.to_string()
    Json::String(text) => text
    Json::Array(items) => {
      let out = StringBuilder()
      let mut first = true
      for item in items {
        if first {
          first = false
        } else {
          out.write_string(",")
        }
        match item {
          Json::Null => ()
          _ => out.write_string(js_string(item))
        }
      }
      out.to_string()
    }
    Json::Object(_) => "[object Object]"
  }
}

///|
/// `Number(value)`: the JavaScript conversion, NaN included.
fn js_number(value : Json) -> Double {
  match value {
    Json::Number(number, ..) => number
    Json::Null => 0.0
    Json::True => 1.0
    Json::False => 0.0
    Json::String(text) => host_number_of_string(text)
    Json::Array(_) => host_number_of_string(js_string(value))
    Json::Object(_) => @double.not_a_number
  }
}

///|
/// The loop's `num(v)`: `typeof v === "number" ? v : Number(v ?? 0) || 0`.
fn js_num(value : Json) -> Double {
  match value {
    Json::Number(number, ..) => number
    _ => {
      let n = js_number(value)
      if n.is_nan() || n == 0.0 {
        0.0
      } else {
        n
      }
    }
  }
}

///|
/// `a === b` for the scalar values a row carries. Two arrays or two objects are never the same value here:
/// the two sides are read out of separate places, and the TypeScript's `===` on them is false as well.
fn js_scalar_equal(a : Json, b : Json) -> Bool {
  match (a, b) {
    (Json::Null, Json::Null) => true
    (Json::True, Json::True) => true
    (Json::False, Json::False) => true
    (Json::Number(x, ..), Json::Number(y, ..)) => x == y
    (Json::String(x), Json::String(y)) => x == y
    _ => false
  }
}

///|
/// Whether a value is the string `text` (the TypeScript's `=== "text"`).
fn is_text(value : Json, text : String) -> Bool {
  match value {
    Json::String(found) => found == text
    _ => false
  }
}

///|
/// `field ?? fallback` for the string fields whose fallback is a string.
fn text_or(value : Json, fallback : String) -> String {
  match value {
    Json::String(text) => text
    _ => fallback
  }
}

///|
/// `typeof value === "string" && value` as a non-empty string, or nothing.
fn non_empty_text(value : Json) -> String? {
  match value {
    Json::String(text) => if text == "" { None } else { Some(text) }
    _ => None
  }
}

///|
/// The strings a value's array holds, each read with `String(item)`: the TypeScript's `strs`.
fn js_strings(value : Json) -> Array[String] {
  let out : Array[String] = []
  for item in array_of(value) {
    out.push(js_string(item))
  }
  out
}

///|
/// `typeof value === "string" ? value : ""`.
fn text_of(value : Json) -> String {
  match value {
    Json::String(text) => text
    _ => ""
  }
}

///|
/// A whole number at or above 1, or nothing (the loop's `Number.isInteger(cap) && cap >= 1`).
fn whole_at_least_one(value : Json) -> Int? {
  match value {
    Json::Number(number, ..) =>
      if number.is_nan() || number != number.floor() || number < 1.0 {
        None
      } else {
        Some(number.to_int())
      }
    _ => None
  }
}

///|
/// Whether an object carries a key (the loop's `"state" in retry`).
fn has_key(value : Json, key : String) -> Bool {
  match value {
    Json::Object(fields) => fields.get(key) is Some(_)
    _ => false
  }
}

///|
/// One object's fields copied with one key replaced.
fn with_text_field(value : Json, key : String, text : String) -> Json {
  let map : Map[String, Json] = Map([])
  match value {
    Json::Object(fields) =>
      for pair in fields.to_array() {
        map.set(pair.0, pair.1)
      }
    Json::Array(_) => ()
    Json::String(_) => ()
    Json::Number(_, ..) => ()
    Json::True => ()
    Json::False => ()
    Json::Null => ()
  }
  map.set(key, Json::string(text))
  Json::object(map)
}

///|
/// One object's fields copied with one key added.
fn with_field(value : Json, key : String, added : Json) -> Json {
  let map : Map[String, Json] = Map([])
  match value {
    Json::Object(fields) =>
      for pair in fields.to_array() {
        map.set(pair.0, pair.1)
      }
    Json::Array(_) => ()
    Json::String(_) => ()
    Json::Number(_, ..) => ()
    Json::True => ()
    Json::False => ()
    Json::Null => ()
  }
  map.set(key, added)
  Json::object(map)
}
