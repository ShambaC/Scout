use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};

/// Per-domain pacing (slot reservation) plus an optional one-at-a-time gate.
#[derive(Default)]
pub struct Limiter {
    next: Mutex<HashMap<String, Instant>>,
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Limiter {
    /// Waits until at least `interval` after the previous slot reserved for `key`.
    pub async fn acquire(&self, key: &str, interval: Duration) {
        let wait = {
            let mut m = self.next.lock().unwrap();
            let now = Instant::now();
            let slot = m.get(key).copied().filter(|t| *t > now).unwrap_or(now);
            m.insert(key.to_string(), slot + interval);
            slot - now
        };
        tokio::time::sleep(wait).await;
    }

    /// Hold the returned mutex across a request to force concurrency 1 for `key`.
    pub fn gate(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.gates.lock().unwrap().entry(key.to_string()).or_default().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spaces_same_domain_not_others() {
        let l = Limiter::default();
        let d = Duration::from_millis(200);
        let t = Instant::now();
        l.acquire("a", d).await;
        l.acquire("a", d).await;
        assert!(t.elapsed() >= d, "same domain must be >= 200ms apart");
        let t = Instant::now();
        l.acquire("b", d).await;
        assert!(t.elapsed() < Duration::from_millis(100), "other domain must not block");
    }
}
