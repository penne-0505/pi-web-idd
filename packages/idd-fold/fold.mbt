// The records fold: the intent column's effective rows, folded in the order they were written into today's
// Purposes, Choices, Waives and harm examples.
//
// A row that points at an id nothing raised is skipped, so the state has no dangling reference. Supersede and
// the drop write the history the fold keeps, so the old Choice's own body stays readable. The answer is one
// JSON object because the caller is on the other side of a process boundary: it hands rows in and reads the
// folded records back, and both folds must answer the same object.

///|
/// The free the fold gives a Choice whose raise names none.
const FREE_WHILE_WHY : String = "why を保つ限り自由"

///|
/// One entry of a Choice's history.
priv struct HistoryEntry {
  at : Json?
  event : String
  by_json : Json?
  grounds : String?
  successor : String?
}

///|
/// A Waive a Choice's own raise carried (`no_why_not`).
priv struct ChoiceWaive {
  reason : String
  by_json : Json?
  at : Json?
}

///|
/// One Choice as the fold reads it.
priv struct ChoiceEntry {
  id : String
  purpose : String
  forms : Json
  mut place : Array[Place]
  why : String
  mut anchored : String
  free : String
  revisit : String?
  verification : Array[String]?
  visibility : Visibility
  mut status : ChoiceStatus
  origin : Json
  history : Array[HistoryEntry]
  waives : Array[ChoiceWaive]
}

///|
/// One Purpose as the fold reads it.
priv struct PurposeEntry {
  id : String
  mut statement : String
  origin : String
  mut name : String?
  mut status : PurposeStatus
  raised : Json?
  by_json : Json?
  mut grounds : String?
  // the statement the raise wrote, kept once a person's restatement replaces `statement`
  mut raised_statement : String?
  // who restated last and when, as `{by, at}`
  mut restated : Json?
}

///|
/// One Waive row.
priv struct WaiveEntry {
  kind : WaiveKind
  choices : Array[String]?
  reason : String?
  change : String?
  at : Json?
  by_json : Json?
}

///|
/// One approved harm example.
priv struct HarmEntry {
  id : String
  statement : String
  harm : Int
  always_must : Bool
  at : Json?
  by_json : Json?
}

///|
/// Whether a row is effective for a viewer: a row of the lane's outside is effective at once, a lane's row
/// until that lane merged, and the lane's own rows until it ended.
fn row_effective(
  row : IntentRow,
  viewer : String?,
  states : Map[String, LaneState],
) -> Bool {
  match row.by_lane {
    None => true
    Some(by_lane) => {
      let state = states.get(by_lane)
      let seen_by_its_own = match viewer {
        Some(seen) => seen == by_lane
        None => false
      }
      if seen_by_its_own {
        match state {
          Some(lane) =>
            match lane.ended_at {
              Some(ended) => !stamp_after(row.at, ended)
              None => true
            }
          None => true
        }
      } else {
        match state {
          Some(lane) =>
            match lane.merged_at {
              Some(merged) => !stamp_after(row.at, merged)
              None => false
            }
          None => false
        }
      }
    }
  }
}

///|
/// The Purpose an id names among the Purposes a lane's GO records named.
fn named_purpose(
  states : Map[String, LaneState],
  lane : String,
  id : String,
) -> LifecyclePurpose? {
  match states.get(lane) {
    None => None
    Some(state) =>
      match state.purposes {
        None => None
        Some(purposes) => {
          let mut found : LifecyclePurpose? = None
          let mut searching = true
          for purpose in purposes {
            if searching && purpose.id == id {
              found = Some(purpose)
              searching = false
            }
          }
          found
        }
      }
  }
}

///|
/// One Place, as the answer carries it.
fn write_place(writer : JsonWriter, place : Place) -> Unit {
  writer.raw("{\"path\":")
  writer.string(place.path)
  writer.raw(",\"kind\":")
  writer.string(place_kind_text(place.kind))
  match place.file {
    Some(file) => {
      writer.raw(",\"file\":")
      writer.string(file)
    }
    None => ()
  }
  match place.symbols {
    Some(symbols) => {
      writer.raw(",\"symbols\":")
      writer.strings(symbols)
    }
    None => ()
  }
  writer.raw("}")
}

///|
/// A Choice's history entry, as the TypeScript writes it: `at`, `event`, then whatever else the row carried.
/// A key the row did not carry is left out; a key it carried as null stays null (a hand-written row).
fn write_history(writer : JsonWriter, entry : HistoryEntry) -> Unit {
  let fields : Array[(String, Json)] = []
  match entry.at {
    Some(at) => fields.push(("at", at))
    None => ()
  }
  fields.push(("event", Json::string(entry.event)))
  match entry.by_json {
    Some(by) => fields.push(("by", by))
    None => ()
  }
  match entry.grounds {
    Some(grounds) => fields.push(("grounds", Json::string(grounds)))
    None => ()
  }
  match entry.successor {
    Some(successor) => fields.push(("successor", Json::string(successor)))
    None => ()
  }
  writer.carried(json_object(fields))
}

///|
/// A Choice's own Waive (`no_why_not` on its raise).
fn write_choice_waive(writer : JsonWriter, waive : ChoiceWaive) -> Unit {
  let fields : Array[(String, Json)] = [("reason", Json::string(waive.reason))]
  match waive.by_json {
    Some(by) => fields.push(("by", by))
    None => ()
  }
  match waive.at {
    Some(at) => fields.push(("at", at))
    None => ()
  }
  writer.carried(json_object(fields))
}

///|
/// One Choice.
fn write_choice(writer : JsonWriter, choice : ChoiceEntry) -> Unit {
  writer.raw("{\"id\":")
  writer.string(choice.id)
  writer.raw(",\"purpose\":")
  writer.string(choice.purpose)
  writer.raw(",\"forms\":")
  writer.carried(choice.forms)
  writer.raw(",\"place\":")
  writer.items(choice.place, write_place)
  writer.raw(",\"why\":")
  writer.string(choice.why)
  writer.raw(",\"anchored\":")
  writer.string(choice.anchored)
  writer.raw(",\"free\":")
  writer.string(choice.free)
  match choice.revisit {
    Some(revisit) => {
      writer.raw(",\"revisit\":")
      writer.string(revisit)
    }
    None => ()
  }
  match choice.verification {
    Some(anchors) => {
      writer.raw(",\"verification\":")
      writer.strings(anchors)
    }
    None => ()
  }
  writer.raw(",\"visibility\":")
  writer.string(visibility_text(choice.visibility))
  writer.raw(",\"status\":")
  writer.string(choice_status_text(choice.status))
  writer.raw(",\"origin\":")
  writer.carried(choice.origin)
  writer.raw(",\"history\":")
  writer.items(choice.history, write_history)
  writer.raw(",\"waives\":")
  writer.items(choice.waives, write_choice_waive)
  writer.raw("}")
}

///|
/// One Purpose.
fn write_purpose(writer : JsonWriter, purpose : PurposeEntry) -> Unit {
  writer.raw("{\"id\":")
  writer.string(purpose.id)
  writer.raw(",\"statement\":")
  writer.string(purpose.statement)
  writer.raw(",\"origin\":")
  writer.string(purpose.origin)
  match purpose.raised_statement {
    Some(raised_statement) => {
      writer.raw(",\"raised_statement\":")
      writer.string(raised_statement)
    }
    None => ()
  }
  match purpose.restated {
    Some(restated) => {
      writer.raw(",\"restated\":")
      writer.carried(restated)
    }
    None => ()
  }
  match purpose.name {
    Some(name) => {
      writer.raw(",\"name\":")
      writer.string(name)
    }
    None => ()
  }
  writer.raw(",\"status\":")
  writer.string(purpose_status_text(purpose.status))
  writer.raw(",\"raised\":")
  let raised : Array[(String, Json)] = []
  match purpose.by_json {
    Some(by) => raised.push(("by", by))
    None => ()
  }
  match purpose.raised {
    Some(at) => raised.push(("at", at))
    None => ()
  }
  writer.carried(json_object(raised))
  match purpose.grounds {
    Some(grounds) => {
      writer.raw(",\"grounds\":")
      writer.string(grounds)
    }
    None => ()
  }
  writer.raw("}")
}

///|
/// One Waive row.
fn write_waive(writer : JsonWriter, waive : WaiveEntry) -> Unit {
  let fields : Array[(String, Json)] = [
    ("kind", Json::string(waive_kind_text(waive.kind))),
  ]
  match waive.choices {
    Some(choices) =>
      fields.push(("choices", Json::array(choices.map(Json::string))))
    None => ()
  }
  match waive.reason {
    Some(reason) => fields.push(("reason", Json::string(reason)))
    None => ()
  }
  match waive.change {
    Some(change) => fields.push(("change", Json::string(change)))
    None => ()
  }
  match waive.at {
    Some(at) => fields.push(("at", at))
    None => ()
  }
  match waive.by_json {
    Some(by) => fields.push(("by", by))
    None => ()
  }
  writer.carried(json_object(fields))
}

///|
/// One harm example.
fn write_harm(writer : JsonWriter, harm : HarmEntry) -> Unit {
  let fields : Array[(String, Json)] = [
    ("id", Json::string(harm.id)),
    ("statement", Json::string(harm.statement)),
    ("harm", Json::number(harm.harm.to_double())),
    ("alwaysMust", Json::boolean(harm.always_must)),
  ]
  match harm.at {
    Some(at) => fields.push(("at", at))
    None => ()
  }
  match harm.by_json {
    Some(by) => fields.push(("by", by))
    None => ()
  }
  writer.carried(json_object(fields))
}

///|
/// The raise's origin: the row's own when it wrote one, else the default a raise with no question carries.
fn choice_origin(row : IntentRow) -> Json {
  match row.origin_json {
    Json::Null => json_object([("by", Json::string("agent"))])
    origin => origin
  }
}

///|
/// The forms a raise carries, or the empty body a hand-written row leaves behind.
fn choice_forms(row : IntentRow) -> Json {
  match row.forms {
    Json::Null =>
      json_object([("chosen", Json::string("")), ("rejected", Json::array([]))])
    forms => forms
  }
}

///|
/// The `by` a row carries, or nothing when the row has no such key (a row written before `by` existed).
fn optional_by(row : IntentRow) -> Json? {
  if row.by_present {
    Some(row.by_json)
  } else {
    None
  }
}

///|
/// The `at` a row carries, or nothing when the key is not there.
fn optional_at(row : IntentRow) -> Json? {
  if row.at_present {
    Some(row.at.json)
  } else {
    None
  }
}

///|
/// The created entry a raise writes, or nothing when neither the migration nor the row carries a date.
fn created_at_opt(row : IntentRow) -> Json? {
  let created = field(field(row.origin_json, "migrated"), "created")
  match created {
    Json::Null => if row.at_present { Some(row.at.json) } else { None }
    other => Some(other)
  }
}

///|
/// The one reading a replacement follows: the successor a row names takes the place of each Choice the row lists.
/// Both the raise that brings a new successor and the row that points at one already standing come here, so the
/// status, the successor and the grounds of a replaced Choice are decided by the same rule (C-204-2).
fn apply_supersedes(
  choices : Map[String, ChoiceEntry],
  successor : String,
  replaced_by : Array[Supersede],
  at : Json?,
  by_json : Json?,
) -> Unit {
  for replaced in replaced_by {
    match choices.get(replaced.id) {
      Some(old) =>
        if choice_status_open(old.status) {
          old.status = ChoiceSuperseded
          old.history.push({
            at,
            event: "superseded",
            by_json,
            grounds: replaced.grounds,
            successor: Some(successor),
          })
        }
      None => ()
    }
  }
}

///|
/// Fold the effective rows into today's records.
fn fold_records_of(
  rows : Array[IntentRow],
  viewer : String?,
  states : Map[String, LaneState],
) -> String {
  let purposes : Map[String, PurposeEntry] = Map([])
  let choices : Map[String, ChoiceEntry] = Map([])
  let waives : Array[WaiveEntry] = []
  let harms : Array[HarmEntry] = []
  for row in rows {
    if !row_effective(row, viewer, states) {
      continue
    }
    match row.event {
      PurposeRaised =>
        match row.id {
          None => ()
          Some(id) => {
            let named = match row.by_lane {
              Some(lane) => named_purpose(states, lane, id)
              None => None
            }
            let name = match named {
              Some(purpose) =>
                match purpose.name {
                  Some(named_name) => Some(named_name)
                  None => row.name
                }
              None => row.name
            }
            let status = match named {
              Some(_) => StatusActive
              None =>
                match row.status {
                  IntentProposed => StatusProposed
                  IntentUnconfirmed => StatusActive
                  OtherIntentStatus(_) => StatusActive
                }
            }
            purposes.set(id, {
              id,
              statement: match row.statement {
                Some(statement) => statement
                None => ""
              },
              origin: match row.origin_text {
                Some(origin) => origin
                None => ""
              },
              name,
              status,
              raised: optional_at(row),
              by_json: optional_by(row),
              grounds: None,
              raised_statement: None,
              restated: None,
            })
          }
        }
      PurposeRestated =>
        match
          purposes.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(purpose) =>
            match row.statement {
              Some(statement) => {
                // the planner's sentence stays readable beside the person's: the first replacement keeps it
                if statement != purpose.statement {
                  if purpose.raised_statement is None {
                    purpose.raised_statement = Some(purpose.statement)
                  }
                  let restated : Array[(String, Json)] = []
                  match optional_by(row) {
                    Some(by) => restated.push(("by", by))
                    None => ()
                  }
                  match optional_at(row) {
                    Some(at) => restated.push(("at", at))
                    None => ()
                  }
                  purpose.restated = Some(json_object(restated))
                }
                purpose.statement = statement
              }
              None => ()
            }
          None => ()
        }
      PurposeConfirmed =>
        match
          purposes.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(purpose) => {
            // the confirming row is written later: its name is the one the outside last gave
            match row.name {
              Some(name) => purpose.name = Some(name)
              None => ()
            }
            if purpose.status == StatusProposed {
              purpose.status = StatusActive
            }
          }
          None => ()
        }
      PurposeRetired =>
        match
          purposes.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(purpose) =>
            if purpose.status == StatusActive {
              purpose.status = StatusRetired
              match row.grounds {
                Some(grounds) => purpose.grounds = Some(grounds)
                None => ()
              }
            }
          None => ()
        }
      PurposeWithdrawn =>
        match
          purposes.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(purpose) =>
            // only a proposal is withdrawn: an active Purpose ends by a retire, and a withdrawn one stays as it is
            if purpose.status == StatusProposed {
              purpose.status = StatusWithdrawn
              match row.grounds {
                Some(grounds) => purpose.grounds = Some(grounds)
                None => ()
              }
            }
          None => ()
        }
      ChoiceRaised =>
        match row.id {
          None => ()
          Some(id) => {
            let history : Array[HistoryEntry] = [
              {
                at: created_at_opt(row),
                event: "created",
                by_json: optional_by(row),
                grounds: None,
                successor: None,
              },
            ]
            let waives_of_raise : Array[ChoiceWaive] = []
            match row.no_why_not {
              Some(reason) =>
                waives_of_raise.push({
                  reason,
                  by_json: optional_by(row),
                  at: optional_at(row),
                })
              None => ()
            }
            let choice : ChoiceEntry = {
              id,
              purpose: match row.purpose {
                Some(purpose) => purpose
                None => ""
              },
              forms: choice_forms(row),
              place: places_of(row.place),
              why: match row.why {
                Some(why) => why
                None => ""
              },
              anchored: match row.anchored {
                Some(anchored) => anchored
                None => ""
              },
              free: match row.free {
                Some(free) => free
                None => FREE_WHILE_WHY
              },
              revisit: row.revisit,
              verification: row.verification,
              visibility: row.visibility,
              status: match row.status {
                IntentUnconfirmed => ChoiceUnconfirmed
                IntentProposed => ChoiceActive
                OtherIntentStatus(_) => ChoiceActive
              },
              origin: choice_origin(row),
              history,
              waives: waives_of_raise,
            }
            choices.set(id, choice)
            apply_supersedes(
              choices,
              id,
              row.supersedes,
              optional_at(row),
              optional_by(row),
            )
          }
        }
      ChoiceSuperseded =>
        match row.id {
          None => ()
          Some(successor) =>
            apply_supersedes(
              choices,
              successor,
              row.supersedes,
              optional_at(row),
              optional_by(row),
            )
        }
      ChoiceReanchored =>
        match
          choices.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(choice) =>
            if choice_status_open(choice.status) {
              match row.place {
                Json::Array(_) => choice.place = places_of(row.place)
                _ => ()
              }
              // an unconfirmed Choice's re-anchor is a move of the Place alone: its anchored is a judgement
              // about the body, and only a confirmation or a Supersede may change that
              match row.anchored {
                Some(anchored) =>
                  if choice.status == ChoiceActive {
                    choice.anchored = anchored
                  }
                None => ()
              }
              choice.history.push({
                at: optional_at(row),
                event: "re-anchored",
                by_json: optional_by(row),
                grounds: None,
                successor: None,
              })
            }
          None => ()
        }
      PlacesMoved =>
        if row.moves.length() > 0 {
          // the landing's follow: the moves rewrite whatever still stands on the old path at this point of the
          // column, so an earlier row's own move is kept and a later one is not touched
          for choice in choices.values() {
            if !choice_status_open(choice.status) {
              continue
            }
            match moved_places(choice.place, row.moves) {
              Some(moved) => {
                choice.place = moved
                choice.history.push({
                  at: optional_at(row),
                  event: "re-anchored",
                  by_json: optional_by(row),
                  grounds: None,
                  successor: None,
                })
              }
              None => ()
            }
          }
        }
      PlacesModule => ()
      ChoiceConfirmed =>
        match
          choices.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(choice) =>
            if choice.status == ChoiceUnconfirmed {
              choice.status = ChoiceActive
              choice.history.push({
                at: optional_at(row),
                event: "confirmed",
                by_json: optional_by(row),
                grounds: None,
                successor: None,
              })
            }
          None => ()
        }
      ChoiceDropped =>
        match
          choices.get(
            match row.id {
              Some(id) => id
              None => ""
            },
          ) {
          Some(choice) =>
            if choice.status == ChoiceUnconfirmed {
              choice.status = ChoiceDropped
              choice.history.push({
                at: optional_at(row),
                event: "dropped",
                by_json: optional_by(row),
                grounds: row.grounds,
                successor: None,
              })
            }
          None => ()
        }
      Waive => {
        let kind = match row.kind {
          RowApplied => Some(WaiveApplied)
          RowNoChoice => Some(WaiveNoChoice)
          OtherRowKind(_) => None
        }
        match kind {
          Some(kind) =>
            waives.push({
              kind,
              choices: row.choices,
              reason: row.reason,
              change: row.change,
              at: optional_at(row),
              by_json: optional_by(row),
            })
          None => ()
        }
      }
      HarmExampleAdded =>
        match (row.id, row.statement, row.harm) {
          (Some(id), Some(statement), Some(harm)) =>
            harms.push({
              id,
              statement,
              harm,
              always_must: row.always_must,
              at: optional_at(row),
              by_json: optional_by(row),
            })
          _ => ()
        }
      OtherIntent(_) => ()
    }
  }
  let writer = JsonWriter::new()
  writer.raw("{\"purposes\":")
  writer.items(purposes.values().collect(), write_purpose)
  writer.raw(",\"choices\":")
  writer.items(choices.values().collect(), write_choice)
  writer.raw(",\"waives\":")
  writer.items(waives, write_waive)
  writer.raw(",\"harmExamples\":")
  writer.items(harms, write_harm)
  writer.raw("}")
  writer.text()
}
