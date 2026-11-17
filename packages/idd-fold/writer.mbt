// Writing the answer as JSON text, straight through.
//
// The answer is handed to the caller as one JSON object, and it is big: fourteen hundred Choices with their
// history is a few megabytes, and one read of the state folds it for every card that shows a Choice. Building
// the value as a tree of `Json` and stringifying the tree costs more than the fold itself, so the answer is
// written as it is folded. The keys and the punctuation are written as the literals they are, so a field costs
// one write rather than a key, a colon and a comma; what a row carried and the fold only hands back (`forms`,
// `origin`, `by`, `at`) is still written by the reader that parsed it, so nothing is re-rendered by hand.

///|
/// Whether the string carries a character JSON writes as an escape.
fn needs_escape(text : String) -> Bool {
  let length = text.length()
  let mut at = 0
  while at < length {
    let code = text.at(at)
    if code == 34 || code == 92 || code < 32 {
      return true
    }
    at = at + 1
  }
  false
}

///|
/// One string, quoted and escaped, as JSON writes it. A string with nothing to escape is written as it is: the
/// content the answer carries is mostly prose, and walking it one character at a time is most of the cost.
fn escaped_into(out : StringBuilder, text : String) -> Unit {
  if !needs_escape(text) {
    out.write_string("\"" + text + "\"")
  } else {
    out.write_char('"')
    for char in text {
      match char {
        '"' => out.write_string("\\\"")
        '\\' => out.write_string("\\\\")
        '\n' => out.write_string("\\n")
        '\r' => out.write_string("\\r")
        '\t' => out.write_string("\\t")
        '\u{08}' => out.write_string("\\b")
        '\u{0C}' => out.write_string("\\f")
        _ =>
          if char.to_int() < 32 {
            // the control characters JSON has no short form for
            out.write_string("\\u00")
            out.write_string(hex_digit(char.to_int()))
          } else {
            out.write_char(char)
          }
      }
    }
    out.write_char('"')
  }
}

///|
/// The two-digit hex of a byte, as JSON writes a control character.
fn hex_digit(code : Int) -> String {
  let digits : Array[String] = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f",
  ]
  digits[code / 16] + digits[code % 16]
}

///|
/// A writer for one answer: the text so far, and the pieces the fold writes into it.
priv struct JsonWriter {
  out : StringBuilder
}

///|
fn JsonWriter::new() -> JsonWriter {
  { out: StringBuilder(size_hint=4194304), }
}

///|
/// Text written as it is: the keys, the punctuation, and the commas between the fields.
fn JsonWriter::raw(writer : JsonWriter, text : String) -> Unit {
  writer.out.write_string(text)
}

///|
/// One string value.
fn JsonWriter::string(writer : JsonWriter, text : String) -> Unit {
  escaped_into(writer.out, text)
}

///|
/// A value the fold only hands back, written by the reader that parsed it.
fn JsonWriter::carried(writer : JsonWriter, value : Json) -> Unit {
  writer.out.write_string(value.stringify())
}

///|
/// One list of records: the opening bracket, the separator between them, and the closing one are the writer's.
fn[T] JsonWriter::items(
  writer : JsonWriter,
  records : Array[T],
  write_one : (JsonWriter, T) -> Unit,
) -> Unit {
  writer.out.write_string("[")
  let mut first = true
  for record in records {
    if first {
      first = false
    } else {
      writer.out.write_string(",")
    }
    write_one(writer, record)
  }
  writer.out.write_string("]")
}

///|
/// One list of strings, written the same way.
fn JsonWriter::strings(writer : JsonWriter, values : Array[String]) -> Unit {
  writer.out.write_string("[")
  let mut first = true
  for value in values {
    if first {
      first = false
    } else {
      writer.out.write_string(",")
    }
    escaped_into(writer.out, value)
  }
  writer.out.write_string("]")
}

///|
/// The text written so far.
fn JsonWriter::text(writer : JsonWriter) -> String {
  writer.out.to_string()
}
