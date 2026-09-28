//! Fee intake: the `fee_source` contract (e.g. open-market) transfers protocol
//! fees into the vault, which are then distributed to stakers via [`crate::pool`].

use soroban_sdk::{token::Client as TokenClient, Address, Env};

use crate::errors::StakingError;
use crate::pool;
use crate::storage_types::{Config, DataKey, PoolState};

/// Pull `amount` of the staking token from `from` into the vault and fold it
/// into the reward pool. Caller must be the configured `fee_source`.
pub fn deposit_fees(env: &Env, from: Address, amount: i128) -> Result<(), StakingError> {
    from.require_auth();

    if amount <= 0 {
        return Err(StakingError::InvalidAmount);
    }

    let config = env
        .storage()
        .instance()
        .get::<DataKey, Config>(&DataKey::Config)
        .ok_or(StakingError::NotInitialized)?;

    if from != config.fee_source {
        return Err(StakingError::Unauthorized);
    }

    let mut pool_state = env
        .storage()
        .instance()
        .get::<DataKey, PoolState>(&DataKey::Pool)
        .ok_or(StakingError::NotInitialized)?;

    let token_client = TokenClient::new(env, &config.token);
    token_client.transfer(&from, &env.current_contract_address(), &amount);

    pool::distribute(env, &mut pool_state, amount)?;

    env.storage().instance().set(&DataKey::Pool, &pool_state);

    Ok(())
}

/// Route early-exit penalty into the reward pool using checked arithmetic.
///
/// When the pool has zero total shares (e.g. every staker has withdrawn), the
/// penalty cannot be divided across positions. In that case it is parked as
/// pending rewards so it is not lost and becomes recoverable once a new staker
/// joins the pool. This mirrors the zero-shares behavior of `deposit_fees`
/// (`test_deposit_fees_with_zero_shares_parks_in_pending_rewards`).
///
/// With a nonzero `total_shares`, the penalty is distributed proportionally to
/// existing positions via [`pool::distribute`].
pub fn route_penalty_to_pool(env: &Env, penalty_amount: i128) -> Result<(), StakingError> {
    if penalty_amount <= 0 {
        return Ok(());
    }

    let mut pool_state = env
        .storage()
        .instance()
        .get::<DataKey, PoolState>(&DataKey::Pool)
        .ok_or(StakingError::NotInitialized)?;

    if pool_state.total_shares == 0 {
        // No positions to divide across: park the penalty as pending rewards
        // instead of dividing by zero. It is folded into the pool once a new
        // staker joins (see `pool::distribute`).
        pool_state.pending_rewards = pool_state
            .pending_rewards
            .checked_add(penalty_amount)
            .ok_or(StakingError::Overflow)?;
    } else {
        pool::distribute(env, &mut pool_state, penalty_amount)?;
    }

    env.storage().instance().set(&DataKey::Pool, &pool_state);

    Ok(())
}
