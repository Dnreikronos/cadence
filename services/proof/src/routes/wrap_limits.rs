use axum::{
    extract::{ConnectInfo, Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use solana_address::Address;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

pub struct Limits {
    window: Mutex<Window>,
    active: Semaphore,
}
struct Window {
    start: Instant,
    total: u32,
    peers: HashMap<Option<IpAddr>, u32>,
    wallets: HashMap<Address, u32>,
}
impl Window {
    fn new(start: Instant) -> Self {
        Self {
            start,
            total: 0,
            peers: HashMap::new(),
            wallets: HashMap::new(),
        }
    }
    fn refresh(&mut self, now: Instant) {
        if now.duration_since(self.start) >= Duration::from_secs(60) {
            *self = Self::new(now);
        }
    }
    fn peer(&mut self, peer: Option<IpAddr>, now: Instant) -> bool {
        self.refresh(now);
        if self.total >= 120 {
            return false;
        }
        self.total += 1;
        let count = self.peers.entry(peer).or_default();
        if *count >= 30 {
            return false;
        }
        *count += 1;
        true
    }
}
impl Limits {
    pub fn new() -> Self {
        Self {
            window: Mutex::new(Window::new(Instant::now())),
            active: Semaphore::new(8),
        }
    }
    pub fn wallet(&self, wallet: Address) -> bool {
        let mut window = self.window.lock().unwrap();
        // The middleware bounds unique wallets before this map can grow.
        let count = window.wallets.entry(wallet).or_default();
        if *count >= 10 {
            return false;
        }
        *count += 1;
        true
    }
}
pub async fn enforce(State(limits): State<Arc<Limits>>, request: Request, next: Next) -> Response {
    enforce_request(limits, request, next, Operation::Wrap).await
}

pub async fn enforce_transfer(
    State(limits): State<Arc<Limits>>,
    request: Request,
    next: Next,
) -> Response {
    enforce_request(limits, request, next, Operation::Transfer).await
}

pub async fn enforce_unwrap(
    State(limits): State<Arc<Limits>>,
    request: Request,
    next: Next,
) -> Response {
    enforce_request(limits, request, next, Operation::Unwrap).await
}
#[derive(Clone, Copy)]
enum Operation {
    Wrap,
    Transfer,
    Unwrap,
}

async fn enforce_request(
    limits: Arc<Limits>,
    request: Request,
    next: Next,
    operation: Operation,
) -> Response {
    let rate_limited = || match operation {
        Operation::Wrap => crate::error::AppError::RateLimited,
        Operation::Transfer => crate::error::AppError::TransferRateLimited,
        Operation::Unwrap => crate::error::AppError::UnwrapRateLimited,
    };
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|p| p.0.ip().to_canonical());
    if !limits.window.lock().unwrap().peer(peer, Instant::now()) {
        return rate_limited().into_response();
    }
    let Ok(_permit) = limits.active.try_acquire() else {
        return rate_limited().into_response();
    };
    if !matches!(operation, Operation::Wrap) {
        tokio::time::timeout(Duration::from_secs(30), next.run(request))
            .await
            .unwrap_or_else(|_| {
                match operation {
                    Operation::Unwrap => {
                        crate::error::AppError::UnwrapUnavailable("unwrap_timeout")
                    }
                    _ => crate::error::AppError::TransferUnavailable("transfer_timeout"),
                }
                .into_response()
            })
    } else {
        next.run(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_and_global_limits_bound_memory_and_reset() {
        let now = Instant::now();
        let mut window = Window::new(now);
        for _ in 0..30 {
            assert!(window.peer(None, now));
        }
        assert!(!window.peer(None, now));
        for i in 0..1000 {
            window.peer(Some(IpAddr::from([10, 0, (i / 256) as u8, i as u8])), now);
        }
        assert!(window.peers.len() <= 120);
        assert!(!window.peer(None, now));
        assert!(window.peer(None, now + Duration::from_secs(60)));
        assert_eq!(window.peers.len(), 1);
    }
    #[test]
    fn wallet_limit_is_shared_across_peers() {
        let limits = Limits::new();
        let wallet = Address::new_from_array([1; 32]);
        for _ in 0..10 {
            assert!(limits.wallet(wallet));
        }
        assert!(!limits.wallet(wallet));
    }
}
