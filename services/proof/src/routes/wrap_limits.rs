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
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|p| p.0.ip().to_canonical());
    if !limits.window.lock().unwrap().peer(peer, Instant::now()) {
        return crate::error::AppError::RateLimited.into_response();
    }
    let Ok(_permit) = limits.active.try_acquire() else {
        return crate::error::AppError::RateLimited.into_response();
    };
    next.run(request).await
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
