//! Bounded, content-free counters. Export never runs on the FUSE request path.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use uuid::Uuid;

pub struct Diagnostics {
    instance_id: Uuid,
    started: AtomicU64,
    completed: AtomicU64,
    errors: AtomicU64,
    duration_micros: AtomicU64,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self {
            instance_id: Uuid::new_v4(),
            started: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            duration_micros: AtomicU64::new(0),
        }
    }
}

impl Diagnostics {
    pub fn request(&self) -> RequestTimer<'_> {
        self.started.fetch_add(1, Ordering::Relaxed);
        RequestTimer {
            diagnostics: self,
            start: Instant::now(),
        }
    }

    pub fn error(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Value {
        // Independent relaxed loads are an approximate health sample, not a
        // transactionally consistent operation journal or a completeness proof.
        json!({
            "version": 1,
            "instanceId": self.instance_id,
            "requestsStarted": self.started.load(Ordering::Relaxed),
            "requestsCompleted": self.completed.load(Ordering::Relaxed),
            "requestErrors": self.errors.load(Ordering::Relaxed),
            "requestDurationMicros": self.duration_micros.load(Ordering::Relaxed),
        })
    }
}

pub struct RequestTimer<'a> {
    diagnostics: &'a Diagnostics,
    start: Instant,
}

impl Drop for RequestTimer<'_> {
    fn drop(&mut self) {
        let micros = u64::try_from(self.start.elapsed().as_micros()).unwrap_or(u64::MAX);
        self.diagnostics
            .duration_micros
            .fetch_add(micros, Ordering::Relaxed);
        self.diagnostics.completed.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_inflight_completed_and_failed_callbacks_without_content() {
        let diagnostics = Diagnostics::default();
        let timer = diagnostics.request();
        assert_eq!(diagnostics.snapshot()["requestsStarted"], 1);
        assert_eq!(diagnostics.snapshot()["requestsCompleted"], 0);
        diagnostics.error();
        drop(timer);
        let snapshot = diagnostics.snapshot();
        assert_eq!(snapshot["requestsCompleted"], 1);
        assert_eq!(snapshot["requestErrors"], 1);
        assert_eq!(snapshot.as_object().unwrap().len(), 6);
        assert_ne!(
            snapshot["instanceId"],
            Diagnostics::default().snapshot()["instanceId"]
        );
    }

    #[test]
    fn counts_concurrent_callbacks() {
        let diagnostics = std::sync::Arc::new(Diagnostics::default());
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let diagnostics = &diagnostics;
                scope.spawn(move || {
                    for _ in 0..1000 {
                        let _timer = diagnostics.request();
                    }
                });
            }
        });
        assert_eq!(diagnostics.snapshot()["requestsCompleted"], 4000);
        assert_eq!(diagnostics.snapshot()["requestErrors"], 0);
    }
}
