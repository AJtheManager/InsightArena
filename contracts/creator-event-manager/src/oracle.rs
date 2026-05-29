use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::admin;
use crate::storage::{self, StorageError};
use crate::storage_types::{DataKey, Event, Match, Winner};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OracleError {
    /// Contract is paused; no operations allowed.
    Paused = 1,
    /// No event found for the given event_id.
    EventNotFound = 2,
    /// Event has been cancelled and cannot be processed.
    EventCancelled = 3,
    /// Not all matches in the event have been resolved yet.
    MatchesNotComplete = 4,
    /// No creation fee has been set (should not happen after init).
    CreationFeeNotSet = 5,
    /// Arithmetic overflow occurred during calculation.
    Overflow = 6,
}

impl From<StorageError> for OracleError {
    fn from(_: StorageError) -> Self {
        OracleError::EventNotFound
    }
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

fn emit_winners_verified(env: &Env, event_id: u64, winner_count: u32) {
    env.events().publish(
        (
            Symbol::new(env, "event"),
            Symbol::new(env, "winners_verified"),
        ),
        (event_id, winner_count),
    );
}

// ---------------------------------------------------------------------------
// verify_event_winners (#798)
// ---------------------------------------------------------------------------

/// Verify and record all perfect scorers for an event.
///
/// # Flow
/// 1. Require caller authorization (public function, anyone can call).
/// 2. Reject if the contract is paused.
/// 3. Retrieve the event and verify it exists.
/// 4. Verify the event is active (not cancelled).
/// 5. Retrieve all matches for the event.
/// 6. Verify all matches have results submitted (is_resolved == true).
/// 7. Retrieve all event participants.
/// 8. For each participant:
///    - Get their predictions for the event.
///    - Count correct predictions.
///    - If correct_count == total_matches, add to winners list.
/// 9. Create Winner structs for perfect scorers.
/// 10. Store winners in EventWinners(event_id).
/// 11. Emit WinnersVerified event with winner count.
/// 12. Return winner count.
///
/// # Returns
/// The number of winners identified (u32).
pub fn verify_event_winners(env: &Env, caller: Address, event_id: u64) -> Result<u32, OracleError> {
    caller.require_auth();

    if admin::is_paused(env) {
        return Err(OracleError::Paused);
    }

    // Retrieve event and verify it exists
    let event: Event = storage::get_event(env, event_id)?;

    // Verify event is active (not cancelled)
    if !event.is_active || event.is_cancelled {
        return Err(OracleError::EventCancelled);
    }

    // Retrieve all matches for the event
    let match_ids = storage::get_event_matches(env, event_id);
    let total_matches = event.match_count;

    // Verify all matches have results submitted
    for match_id in match_ids.iter() {
        let m: Match = storage::get_match(env, match_id)?;
        if !m.result_submitted {
            return Err(OracleError::MatchesNotComplete);
        }
    }

    // Retrieve all event participants
    let participants = storage::get_event_participants(env, event_id);

    let mut winners: Vec<Winner> = Vec::new(env);
    let now = env.ledger().timestamp();

    // For each participant, check if they predicted all matches correctly
    for participant in participants.iter() {
        let user_predictions = storage::get_user_predictions(env, &participant, event_id);

        // Count correct predictions
        let mut correct_count: u32 = 0;
        let mut last_prediction_time: u64 = 0;

        for prediction_id in user_predictions.iter() {
            if let Ok(prediction) = storage::get_prediction(env, prediction_id) {
                // Grade the prediction against the match result
                let m: Match = storage::get_match(env, prediction.match_id)?;
                if let Some(actual_winner) = m.winning_team {
                    let is_correct = prediction_outcome_matches(
                        env,
                        &prediction.predicted_outcome,
                        actual_winner,
                    );
                    if is_correct {
                        correct_count =
                            correct_count.checked_add(1).ok_or(OracleError::Overflow)?;
                    }
                }
                // Track the latest prediction time for tiebreaker
                if prediction.predicted_at > last_prediction_time {
                    last_prediction_time = prediction.predicted_at;
                }
            }
        }

        // If correct_count == total_matches, add to winners list
        if correct_count == total_matches && total_matches > 0 {
            let winner = Winner::new(
                participant.clone(),
                event_id,
                correct_count,
                total_matches,
                last_prediction_time,
                now,
            );
            winners.push_back(winner);
        }
    }

    let winner_count = winners.len() as u32;

    // Store winners in EventWinners(event_id)
    let winners_key = DataKey::EventWinners(event_id);
    env.storage().persistent().set(&winners_key, &winners);
    env.storage()
        .persistent()
        .extend_ttl(&winners_key, storage::TTL_LEDGERS, storage::TTL_LEDGERS);

    // Emit WinnersVerified event
    emit_winners_verified(env, event_id, winner_count);

    Ok(winner_count)
}

// ---------------------------------------------------------------------------
// get_event_winners (#799)
// ---------------------------------------------------------------------------

/// Retrieve the list of winners for an event.
///
/// # Flow
/// 1. Retrieve EventWinners(event_id) from storage.
/// 2. Return Vec<Winner> sorted by completion_time (earliest first).
/// 3. Return empty Vec if no winners exist.
///
/// # Returns
/// A `Vec<Winner>` sorted by completion_time ascending (earliest first).
pub fn get_event_winners(env: &Env, event_id: u64) -> Result<Vec<Winner>, OracleError> {
    let mut winners = storage::get_event_winners(env, event_id);

    // Sort by completion_time ascending (earliest first)
    // Using insertion sort since the list is typically small
    let len = winners.len();
    for i in 1..len {
        let mut j = i;
        while j > 0 {
            let prev = winners.get(j - 1).unwrap();
            let curr = winners.get(j).unwrap();
            if prev.completion_time > curr.completion_time {
                winners.set(j - 1, curr);
                winners.set(j, prev);
                j -= 1;
            } else {
                break;
            }
        }
    }

    Ok(winners)
}

// ---------------------------------------------------------------------------
// get_user_score (#800)
// ---------------------------------------------------------------------------

/// Calculate a user's score (correct predictions) for an event.
///
/// # Flow
/// 1. Retrieve user's predictions for the event.
/// 2. Count predictions where the user predicted correctly.
/// 3. Get total match count for the event.
/// 4. Return tuple: (correct_count: u32, total_matches: u32).
///
/// # Returns
/// A tuple `(correct_count, total_matches)` where:
/// - `correct_count`: Number of matches the user predicted correctly.
/// - `total_matches`: Total number of matches in the event.
pub fn get_user_score(env: &Env, user: Address, event_id: u64) -> Result<(u32, u32), OracleError> {
    // Retrieve event to get total match count
    let event: Event = storage::get_event(env, event_id)?;
    let total_matches = event.match_count;

    // Retrieve user's predictions for the event
    let user_predictions = storage::get_user_predictions(env, &user, event_id);

    // Count correct predictions
    let mut correct_count: u32 = 0;
    for prediction_id in user_predictions.iter() {
        if let Ok(prediction) = storage::get_prediction(env, prediction_id) {
            // Grade the prediction against the match result
            let m: Match = storage::get_match(env, prediction.match_id)?;
            if let Some(actual_winner) = m.winning_team {
                let is_correct =
                    prediction_outcome_matches(env, &prediction.predicted_outcome, actual_winner);
                if is_correct {
                    correct_count = correct_count.checked_add(1).ok_or(OracleError::Overflow)?;
                }
            }
        }
    }

    Ok((correct_count, total_matches))
}

// ---------------------------------------------------------------------------
// get_creation_fee (#801)
// ---------------------------------------------------------------------------

/// Retrieve the current XLM fee required to create an event.
///
/// # Flow
/// 1. Retrieve CreationFee from storage.
/// 2. Return i128 value.
/// 3. Return default if not set (should not happen after init).
///
/// # Returns
/// The creation fee in stroops (i128).
pub fn get_creation_fee(env: &Env) -> Result<i128, OracleError> {
    admin::get_creation_fee(env).ok_or(OracleError::CreationFeeNotSet)
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Check if a predicted outcome matches the actual match result.
///
/// The actual_winner encoding is:
/// - 0 = Team A
/// - 1 = Team B
/// - 2 = Draw
fn prediction_outcome_matches(env: &Env, predicted_outcome: &Symbol, actual_winner: u32) -> bool {
    let team_a_sym = Symbol::new(env, crate::storage_types::OUTCOME_TEAM_A);
    let team_b_sym = Symbol::new(env, crate::storage_types::OUTCOME_TEAM_B);
    let draw_sym = Symbol::new(env, crate::storage_types::OUTCOME_DRAW);

    match actual_winner {
        0 => *predicted_outcome == team_a_sym,
        1 => *predicted_outcome == team_b_sym,
        2 => *predicted_outcome == draw_sym,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: Unit tests for oracle functions require Soroban contract context.
    // Integration tests are provided in tests/ directory.
    // To run integration tests: cargo test --test oracle_integration_tests
    //
    // Unit tests would require wrapping all storage access with env.as_contract(),
    // which is better handled in integration tests with proper contract setup.
}
