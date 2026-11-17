// The lane state: what a lane's lifecycle says about when it landed and when it ended.
//
// A viewer sees a lane's rows until the lane merged, and the lane itself sees its rows until it ended. The
// earliest of each is what counts: a lane that was closed and opened again keeps the first landing, and an
// ended lane stays ended. The GO's purposes ride on the same fold, because the confirmation of a Purpose is
// written on the GO's own row rather than as a second row of the intent column.

///|
/// One lane's reading.
priv struct LaneState {
  mut merged_at : Stamp?
  mut ended_at : Stamp?
  mut purposes : Array[LifecyclePurpose]?
}

///|
/// Note one lifecycle row into the lanes' states.
fn note_lane_row(states : Map[String, LaneState], row : LifecycleRow) -> Unit {
  let state = match states.get(row.idd_id) {
    Some(existing) => existing
    None => {
      let fresh : LaneState = {
        merged_at: None,
        ended_at: None,
        purposes: None,
      }
      states.set(row.idd_id, fresh)
      fresh
    }
  }
  match row.event {
    LaneClose => {
      match row.outcome {
        OutcomeMerged =>
          state.merged_at = Some(earlier_stamp(state.merged_at, row.at))
        OutcomeLocal =>
          state.merged_at = Some(earlier_stamp(state.merged_at, row.at))
        OutcomeAborted => ()
        OutcomeDropped => ()
        OtherLaneOutcome(_) => ()
      }
      state.ended_at = Some(earlier_stamp(state.ended_at, row.at))
    }
    S1Defer | S3Defer =>
      state.ended_at = Some(earlier_stamp(state.ended_at, row.at))
    S1Go =>
      match row.purposes {
        // several GOs (a revise and a second GO) add up, in the order they were written
        Some(named) => {
          let kept : Array[LifecyclePurpose] = match state.purposes {
            Some(previous) => previous.copy()
            None => []
          }
          kept.append(named)
          state.purposes = Some(kept)
        }
        None => ()
      }
    OtherLifecycle(_) => ()
  }
}

///|
/// One Purpose a lane's GO named, as JSON.
fn life_purpose_json(purpose : LifecyclePurpose) -> Json {
  let fields : Array[(String, Json)] = [("id", Json::string(purpose.id))]
  for pair in maybe("name", purpose.name) {
    fields.push(pair)
  }
  json_object(fields)
}

///|
/// One lane's state, as JSON: only the parts it has (the TypeScript fold leaves the others out too).
fn lane_state_json(state : LaneState) -> Json {
  let fields : Array[(String, Json)] = []
  match state.merged_at {
    Some(merged) => fields.push(("mergedAt", merged.json))
    None => ()
  }
  match state.ended_at {
    Some(ended) => fields.push(("endedAt", ended.json))
    None => ()
  }
  match state.purposes {
    Some(purposes) =>
      fields.push(("purposes", Json::array(purposes.map(life_purpose_json))))
    None => ()
  }
  json_object(fields)
}

///|
/// Every lane's state, as JSON.
fn lane_states_json(states : Map[String, LaneState]) -> Json {
  let fields : Array[(String, Json)] = []
  for pair in states.to_array() {
    fields.push((pair.0, lane_state_json(pair.1)))
  }
  json_object(fields)
}

///|
/// The lanes of a state's JSON, read back: the fold takes the state it was handed, not the one it last made.
fn lane_states_of(value : Json) -> Map[String, LaneState] {
  let states : Map[String, LaneState] = Map([])
  let fields = match value {
    Json::Object(fields) => fields
    _ => Map([])
  }
  for pair in fields.to_array() {
    let entry = pair.1
    let purposes = match field(entry, "purposes") {
      Json::Array(_) => purposes_of(field(entry, "purposes"))
      _ => None
    }
    states.set(pair.0, {
      merged_at: stamp_at(field(entry, "mergedAt")),
      ended_at: stamp_at(field(entry, "endedAt")),
      purposes,
    })
  }
  states
}

///|
/// The stamp of a JSON value, or nothing when the field is not there.
fn stamp_at(value : Json) -> Stamp? {
  match value {
    Json::Null => None
    _ => Some(stamp_of(value))
  }
}
