use super::{Local, Settings};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::async_runtime::{channel, Receiver, Sender};

const MANUAL_QUEUE_CAPACITY: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureIntent {
    Scheduled,
    Manual,
    Maintenance,
}

#[derive(Clone)]
pub(super) struct CaptureTicket {
    pub generation: u64,
    pub intent: CaptureIntent,
    pub settings: Settings,
}

pub(super) struct Work {
    pub ticket: CaptureTicket,
    pub reply: Option<Sender<Result<(), String>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecordingStatePayload {
    pub is_paused: bool,
    pub interval_minutes: i64,
    pub is_capturing: bool,
    pub is_maintaining: bool,
    pub queued_manual_captures: usize,
    pub next_scheduled_attempt_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub generation: u64,
    pub revision: u64,
}

pub(super) struct Core {
    pub settings: Settings,
    pub generation: u64,
    pub revision: u64,
    pub closed: bool,
    pub active: bool,
    maintenance_requested: bool,
    reconcile_requested: bool,
    maintenance_deadline: Option<Instant>,
    active_maintenance: bool,
    pub maintaining: bool,
    pub deadline: Option<Instant>,
    pub last_attempt_at: Option<i64>,
    manual: VecDeque<Sender<Result<(), String>>>,
}

impl Core {
    fn new(settings: Settings, now: Instant) -> Self {
        let deadline = (!settings.is_paused).then_some(now);
        Self {
            settings,
            generation: 0,
            revision: 0,
            closed: false,
            active: false,
            maintenance_requested: false,
            reconcile_requested: false,
            maintenance_deadline: None,
            active_maintenance: false,
            maintaining: false,
            deadline,
            last_attempt_at: None,
            manual: VecDeque::new(),
        }
    }

    pub fn apply_settings(&mut self, settings: Settings, now: Instant) {
        self.revision += 1;
        let privacy_changed = self.settings.is_paused != settings.is_paused
            || self.settings.excluded_processes != settings.excluded_processes
            || self.settings.excluded_window_keywords != settings.excluded_window_keywords
            || self.settings.pause_processes != settings.pause_processes
            || self.settings.pause_window_keywords != settings.pause_window_keywords
            || self.settings.sensitive_window_keywords != settings.sensitive_window_keywords
            || self.settings.sensitive_capture_mode.as_str()
                != settings.sensitive_capture_mode.as_str();
        if privacy_changed {
            self.generation += 1;
            self.cancel_queued("Capture cancelled because recording or privacy settings changed.");
        }
        if settings.is_paused {
            self.deadline = None;
        } else if self.settings.is_paused {
            self.deadline = Some(now); // Resume is an immediate attempt, not an old sleep.
        } else if self.settings.interval_minutes != settings.interval_minutes {
            self.deadline = Some(now + Self::interval(&settings));
        }
        self.settings = settings;
    }

    fn interval(settings: &Settings) -> Duration {
        Duration::from_secs(settings.interval_minutes.max(1) as u64 * 60)
    }

    pub fn ticket_valid(&self, ticket: &CaptureTicket) -> bool {
        !self.closed
            && !self.maintaining
            && self.generation == ticket.generation
            && (ticket.intent == CaptureIntent::Manual || !self.settings.is_paused)
    }

    pub fn next(&mut self, now: Instant) -> Option<Work> {
        if self.closed || self.active || self.maintaining {
            return None;
        }
        if self.maintenance_requested || self.maintenance_deadline.is_some_and(|d| now >= d) {
            self.maintenance_requested = false;
            self.maintenance_deadline = None;
            self.active = true;
            self.active_maintenance = true;
            self.revision += 1;
            return Some(Work {
                ticket: CaptureTicket {
                    generation: self.generation,
                    intent: CaptureIntent::Maintenance,
                    settings: self.settings.clone(),
                },
                reply: None,
            });
        }
        let reply = self.manual.pop_front();
        let intent = if reply.is_some() {
            CaptureIntent::Manual
        } else if !self.settings.is_paused && self.deadline.is_some_and(|d| now >= d) {
            CaptureIntent::Scheduled
        } else {
            return None;
        };
        self.revision += 1;
        self.active = true;
        self.last_attempt_at = Some(Local::now().timestamp_millis());
        if intent == CaptureIntent::Scheduled {
            self.deadline = Some(now + Self::interval(&self.settings));
        }
        Some(Work {
            ticket: CaptureTicket {
                generation: self.generation,
                intent,
                settings: self.settings.clone(),
            },
            reply,
        })
    }

    // Suppression, failure and success all finish an attempt, without catch-up bursts.
    pub fn finish(&mut self, ticket: &CaptureTicket, now: Instant) {
        self.revision += 1;
        self.active = false;
        if ticket.intent == CaptureIntent::Maintenance {
            self.active_maintenance = false;
            if !self.closed {
                self.maintenance_deadline = Some(now + Duration::from_secs(300));
            }
        }
        if !self.closed
            && !self.settings.is_paused
            && ticket.intent == CaptureIntent::Scheduled
            && self.generation == ticket.generation
        {
            self.deadline = Some(now + Self::interval(&self.settings));
        }
    }

    fn cancel_queued(&mut self, message: &str) {
        for reply in self.manual.drain(..) {
            let _ = reply.try_send(Err(message.to_string()));
        }
    }

    pub fn begin_restore(&mut self) {
        self.maintaining = true;
        self.generation += 1;
        self.revision += 1;
        self.cancel_queued("Capture cancelled while the library is being restored.");
    }

    pub fn end_restore(&mut self) {
        self.maintaining = false;
        self.revision += 1;
    }

    pub fn snapshot(&self, now: Instant) -> RecordingStatePayload {
        RecordingStatePayload {
            is_paused: self.settings.is_paused,
            interval_minutes: self.settings.interval_minutes,
            is_capturing: self.active && !self.active_maintenance,
            is_maintaining: self.maintaining || self.active_maintenance,
            queued_manual_captures: self.manual.len(),
            last_attempt_at: self.last_attempt_at,
            next_scheduled_attempt_at: self
                .deadline
                .filter(|_| !self.closed && !self.maintaining)
                .map(|d| {
                    Local::now().timestamp_millis()
                        + d.saturating_duration_since(now).as_millis() as i64
                }),
            generation: self.generation,
            revision: self.revision,
        }
    }
}

pub(super) struct CaptureCoordinator {
    core: Mutex<Core>,
    published: Mutex<RecordingStatePayload>,
    wake: Condvar,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    shutdown_started: AtomicBool,
    shutdown_complete: AtomicBool,
}

impl CaptureCoordinator {
    pub fn new(settings: Settings) -> Self {
        let core = Core::new(settings, Instant::now());
        let published = core.snapshot(Instant::now());
        Self {
            core: Mutex::new(core),
            published: Mutex::new(published),
            wake: Condvar::new(),
            worker: Mutex::new(None),
            shutdown_started: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
        }
    }
    // This mutex is also the persistence barrier. No acquisition or encoding takes place under it.
    pub fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn request_maintenance(&self, reconcile: bool) {
        let mut core = self.lock();
        if core.closed {
            return;
        }
        core.maintenance_requested = true;
        core.reconcile_requested |= reconcile;
        self.notify();
    }
    pub fn take_reconciliation(&self) -> bool {
        let mut core = self.lock();
        std::mem::take(&mut core.reconcile_requested)
    }
    pub fn notify(&self) {
        self.wake.notify_all();
    }
    pub fn begin_restore(&self) -> Result<(), String> {
        let mut core = self.lock();
        if core.closed {
            return Err("Capture worker is shutting down.".into());
        }
        core.begin_restore();
        self.cache_snapshot(&core);
        self.notify();
        // Cancel acquisition/encoding, then wait for the existing attempt's post-commit
        // cleanup/retention to finish. The wait releases the barrier so pause can proceed.
        while core.active && !core.closed {
            core = self.wake.wait(core).unwrap_or_else(|e| e.into_inner());
        }
        if core.closed {
            core.end_restore();
            self.cache_snapshot(&core);
            return Err("Capture worker is shutting down.".into());
        }
        Ok(())
    }
    pub fn cache_snapshot(&self, core: &Core) {
        let next = core.snapshot(Instant::now());
        let mut published = self.published.lock().unwrap_or_else(|e| e.into_inner());
        if next.revision >= published.revision {
            *published = next;
        }
    }
    pub fn recording_state(&self) -> RecordingStatePayload {
        self.published
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn snapshot(&self) -> RecordingStatePayload {
        let core = self.lock();
        self.cache_snapshot(&core);
        core.snapshot(Instant::now())
    }

    pub fn request_manual(&self) -> Result<Receiver<Result<(), String>>, String> {
        if self.shutdown_started.load(Ordering::Acquire) {
            return Err("Capture worker is shutting down.".into());
        }
        let mut core = match self.core.try_lock() {
            Ok(core) => core,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err("Capture is saving or settings are changing. Try again shortly.".into())
            }
        };
        if core.closed {
            return Err("Capture worker is shutting down.".to_string());
        }
        if core.maintaining {
            return Err(
                "Library restore is in progress. Try capturing again when it finishes.".into(),
            );
        }
        if core.manual.len() >= MANUAL_QUEUE_CAPACITY {
            return Err(
                "Capture queue is full. Wait for the current captures to finish.".to_string(),
            );
        }
        let (tx, rx) = channel(1);
        core.revision += 1;
        core.manual.push_back(tx);
        self.cache_snapshot(&core);
        self.notify();
        Ok(rx)
    }
    #[cfg(test)]
    pub fn wait_next(&self) -> Option<Work> {
        self.wait_next_with_idle(|_| {})
    }
    pub fn wait_next_with_idle(&self, mut idle: impl FnMut(bool)) -> Option<Work> {
        let mut core = self.lock();
        loop {
            if core.closed {
                return None;
            }
            if let Some(work) = core.next(Instant::now()) {
                self.cache_snapshot(&core);
                return Some(work);
            }
            idle(core.settings.is_paused);
            let deadline = if core.maintaining {
                None
            } else {
                core.deadline
                    .into_iter()
                    .chain(core.maintenance_deadline)
                    .min()
            };
            core = if let Some(deadline) = deadline {
                self.wake
                    .wait_timeout(core, deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            } else {
                self.wake.wait(core).unwrap_or_else(|e| e.into_inner())
            };
        }
    }
    pub fn attach_worker(&self, worker: std::thread::JoinHandle<()>) {
        *self.worker.lock().unwrap() = Some(worker);
    }
    pub fn start_shutdown(&self) -> bool {
        self.shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub fn shutdown_complete(&self) -> bool {
        self.shutdown_complete.load(Ordering::Acquire)
    }
    pub fn is_shutting_down(&self) -> bool {
        self.shutdown_started.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) {
        self.shutdown_started.store(true, Ordering::Release);
        {
            let mut core = self.lock();
            core.revision += 1;
            core.closed = true;
            core.generation += 1;
            core.deadline = None;
            core.cancel_queued("Capture worker is shutting down.");
            self.cache_snapshot(&core);
        }
        self.notify();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
        self.shutdown_complete.store(true, Ordering::Release);
    }
}

pub(super) struct CommandAdmission {
    active: Arc<AtomicUsize>,
    capacity: usize,
}
pub(super) struct CommandPermit(Arc<AtomicUsize>);
impl Drop for CommandPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl CommandAdmission {
    pub fn new(capacity: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            capacity,
        }
    }
    pub fn enter(&self) -> Result<CommandPermit, String> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.capacity).then_some(n + 1)
            })
            .map_err(|_| {
                "Archive is busy. Wait for the current operation and try again.".to_string()
            })?;
        Ok(CommandPermit(self.active.clone()))
    }
}

pub(super) async fn run_blocking<T: Send + 'static>(
    admission: &CommandAdmission,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = admission.enter()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|e| format!("Archive worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::tests::build_test_state;

    #[test]
    fn paused_maintenance_coalesces_and_has_an_independent_low_frequency_deadline() {
        let (_temp, state) = build_test_state();
        let now = Instant::now();
        {
            let mut core = state.coordinator.lock();
            let mut settings = core.settings.clone();
            settings.is_paused = true;
            core.apply_settings(settings, now);
        }
        for _ in 0..100 {
            state.coordinator.request_maintenance(true);
        }
        let first = state.coordinator.lock().next(now).unwrap();
        assert_eq!(first.ticket.intent, CaptureIntent::Maintenance);
        assert!(state.coordinator.take_reconciliation());
        assert!(!state.coordinator.take_reconciliation());
        let mut core = state.coordinator.lock();
        core.finish(&first.ticket, now);
        assert!(core.next(now + Duration::from_secs(299)).is_none());
        let deadline = core.next(now + Duration::from_secs(300)).unwrap();
        assert_eq!(deadline.ticket.intent, CaptureIntent::Maintenance);
        core.finish(&deadline.ticket, now + Duration::from_secs(300));
        assert!(core.settings.is_paused);
        assert!(!core.active);
    }

    #[test]
    fn paused_maintenance_waiter_wakes_on_request_and_shuts_down_without_polling() {
        let (_temp, state) = build_test_state();
        {
            let mut core = state.coordinator.lock();
            core.settings.is_paused = true;
            core.deadline = None;
        }
        let coordinator = state.coordinator.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            while let Some(work) = coordinator.wait_next() {
                assert_eq!(work.ticket.intent, CaptureIntent::Maintenance);
                coordinator.lock().finish(&work.ticket, Instant::now());
                coordinator.notify();
                tx.send(()).unwrap();
            }
        });
        state.coordinator.attach_worker(worker);
        state.coordinator.request_maintenance(false);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        state.coordinator.shutdown();
        assert!(state.coordinator.shutdown_complete());
    }

    #[test]
    fn recording_state_remains_available_with_saturated_admission_and_persistence() {
        let (_temp, state) = build_test_state();
        let permits: Vec<_> = (0..8).map(|_| state.commands.enter().unwrap()).collect();
        assert!(state.commands.enter().is_err());
        let mut core = state.coordinator.lock();
        let mut settings = core.settings.clone();
        settings.is_paused = true;
        crate::backend::apply_recording_settings_locked(&state, &mut core, settings);
        // Keep the persistence barrier locked: this read touches only the tiny DTO cache.
        let payload = state.coordinator.recording_state();
        assert!(payload.is_paused);
        assert_eq!(payload.revision, core.revision);
        drop(permits);
    }

    #[test]
    fn manual_requests_are_bounded_and_allowed_while_paused() {
        let (_temp, state) = build_test_state();
        let coordinator = &state.coordinator;
        let mut paused = coordinator.lock().settings.clone();
        paused.is_paused = true;
        coordinator.lock().apply_settings(paused, Instant::now());
        let _first = coordinator.request_manual().unwrap();
        let _second = coordinator.request_manual().unwrap();
        assert!(coordinator.request_manual().is_err());
        let work = coordinator.lock().next(Instant::now()).unwrap();
        assert_eq!(work.ticket.intent, CaptureIntent::Manual);
        assert!(coordinator.lock().ticket_valid(&work.ticket));
        assert!(coordinator.lock().next(Instant::now()).is_none());
    }

    #[test]
    fn pause_privacy_changes_and_shutdown_fence_active_attempts() {
        let (_temp, state) = build_test_state();
        let now = Instant::now();
        let mut core = state.coordinator.lock();
        let work = core.next(now).unwrap();
        let mut settings = core.settings.clone();
        settings.is_paused = true;
        core.apply_settings(settings, now);
        assert!(!core.ticket_valid(&work.ticket));
        assert!(core.deadline.is_none());
        core.finish(&work.ticket, now);
        let mut settings = core.settings.clone();
        settings.is_paused = false;
        core.apply_settings(settings, now);
        let work = core.next(now).unwrap();
        let mut settings = core.settings.clone();
        settings.excluded_processes.push("secret.exe".into());
        core.apply_settings(settings, now);
        assert!(!core.ticket_valid(&work.ticket));
        core.finish(&work.ticket, now);
        drop(core);
        state.coordinator.shutdown();
        assert!(!state.coordinator.lock().ticket_valid(&work.ticket));
        assert!(state.coordinator.request_manual().is_err());
    }

    #[test]
    fn deadlines_follow_interval_changes_resume_and_every_attempt_outcome() {
        let (_temp, state) = build_test_state();
        let now = Instant::now();
        let mut core = state.coordinator.lock();
        let attempt = core.next(now).unwrap();
        assert!(core.last_attempt_at.is_some());
        core.finish(&attempt.ticket, now + Duration::from_secs(3));
        assert_eq!(core.deadline, Some(now + Duration::from_secs(123)));
        let mut settings = core.settings.clone();
        settings.interval_minutes = 240;
        core.apply_settings(settings, now);
        assert_eq!(core.deadline, Some(now + Duration::from_secs(14400)));
        let mut settings = core.settings.clone();
        settings.interval_minutes = 1;
        core.apply_settings(settings, now);
        assert_eq!(core.deadline, Some(now + Duration::from_secs(60)));
        let mut settings = core.settings.clone();
        settings.is_paused = true;
        core.apply_settings(settings, now);
        assert!(core.next(now + Duration::from_secs(15000)).is_none());
        let mut settings = core.settings.clone();
        settings.is_paused = false;
        core.apply_settings(settings, now);
        assert_eq!(core.deadline, Some(now));
    }

    #[test]
    fn bounded_command_admission_releases_on_error_or_panic() {
        let admission = CommandAdmission::new(1);
        let permit = admission.enter().unwrap();
        assert!(admission.enter().is_err());
        drop(permit);
        let _ = std::panic::catch_unwind(|| {
            let _permit = admission.enter().unwrap();
            panic!("injected");
        });
        assert!(admission.enter().is_ok());
    }

    #[test]
    fn paused_worker_wakes_on_resume_and_shutdown_without_database_polling() {
        let (_temp, state) = build_test_state();
        let coordinator = state.coordinator.clone();
        let mut settings = coordinator.lock().settings.clone();
        settings.is_paused = true;
        coordinator.lock().apply_settings(settings, Instant::now());
        let worker_coordinator = coordinator.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let work = worker_coordinator
                .wait_next_with_idle(|paused| {
                    if paused {
                        started_tx.send(()).unwrap();
                    }
                })
                .unwrap();
            result_tx.send(work.ticket.intent).unwrap();
            worker_coordinator
                .lock()
                .finish(&work.ticket, Instant::now());
            assert!(worker_coordinator.wait_next().is_none());
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut settings = coordinator.lock().settings.clone();
        settings.is_paused = false;
        coordinator.lock().apply_settings(settings, Instant::now());
        coordinator.notify();
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            CaptureIntent::Scheduled
        );
        coordinator.shutdown();
        worker.join().unwrap();
        assert!(coordinator.shutdown_complete());
        assert!(!coordinator.start_shutdown());
    }

    #[test]
    fn queued_manual_requests_are_cancelled_on_privacy_change_and_shutdown() {
        let (_temp, state) = build_test_state();
        let mut first = state.coordinator.request_manual().unwrap();
        let mut settings = state.coordinator.lock().settings.clone();
        settings.excluded_processes.push("secret.exe".into());
        state
            .coordinator
            .lock()
            .apply_settings(settings, Instant::now());
        assert!(first.try_recv().unwrap().is_err());
        let mut second = state.coordinator.request_manual().unwrap();
        state.coordinator.shutdown();
        assert!(second.try_recv().unwrap().is_err());
        assert!(state
            .coordinator
            .snapshot()
            .next_scheduled_attempt_at
            .is_none());
    }

    #[test]
    fn restoration_fences_active_captures_and_resumes_after_failure() {
        let (_temp, state) = build_test_state();
        let now = Instant::now();
        let work = state.coordinator.lock().next(now).unwrap();
        state.coordinator.lock().begin_restore();
        assert!(!state.coordinator.lock().ticket_valid(&work.ticket));
        assert!(state.coordinator.snapshot().is_maintaining);
        assert!(state.coordinator.request_manual().is_err());
        state.coordinator.lock().finish(&work.ticket, now);
        state.coordinator.lock().end_restore();
        assert!(!state.coordinator.snapshot().is_maintaining);
        assert!(state.coordinator.request_manual().is_ok());
    }

    #[test]
    fn state_revisions_order_attempts_within_a_privacy_generation() {
        let (_temp, state) = build_test_state();
        let initial = state.coordinator.snapshot();
        let work = state.coordinator.lock().next(Instant::now()).unwrap();
        let active = state.coordinator.snapshot();
        state
            .coordinator
            .lock()
            .finish(&work.ticket, Instant::now());
        let finished = state.coordinator.snapshot();
        assert!(active.is_capturing && !finished.is_capturing);
        assert_eq!(initial.generation, finished.generation);
        assert!(initial.revision < active.revision && active.revision < finished.revision);
        // The tray's submission path must never wait on persistence/DB work.
        let _saving = state.coordinator.lock();
        assert!(state.coordinator.request_manual().is_err());
    }

    #[test]
    fn restore_waits_for_active_attempt_cleanup_before_live_replacement() {
        let (_temp, state) = build_test_state();
        let coordinator = state.coordinator.clone();
        let active_coordinator = coordinator.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (cleanup_tx, cleanup_rx) = std::sync::mpsc::channel();
        coordinator.attach_worker(std::thread::spawn(move || {
            let work = active_coordinator.wait_next().unwrap();
            started_tx.send(()).unwrap();
            cleanup_rx.recv().unwrap();
            active_coordinator
                .lock()
                .finish(&work.ticket, Instant::now());
            active_coordinator.notify();
            assert!(active_coordinator.wait_next().is_none());
        }));
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let restore_coordinator = coordinator.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let restore = std::thread::spawn(move || {
            restore_coordinator.begin_restore().unwrap();
            ready_tx.send(()).unwrap();
        });
        {
            let mut core = coordinator.lock();
            while !core.maintaining {
                let (next, timeout) = coordinator
                    .wake
                    .wait_timeout(core, Duration::from_secs(2))
                    .unwrap();
                core = next;
                assert!(!timeout.timed_out());
            }
        }
        assert!(ready_rx.try_recv().is_err());
        assert!(coordinator.request_manual().is_err());
        cleanup_tx.send(()).unwrap();
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        restore.join().unwrap();
        assert!(!coordinator.snapshot().is_capturing);
        coordinator.shutdown();
    }
}
