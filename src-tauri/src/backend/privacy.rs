use super::{evaluate_capture_policy, CaptureSuppressedEventPayload, Settings};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VisibleWindow {
    pub handle: usize,
    pub rect: (i32, i32, i32, i32),
    pub title: String,
    pub process: String,
    pub title_known: bool,
    pub process_known: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PrivacySnapshot {
    pub monitor: usize,
    pub bounds: (i32, i32, i32, i32),
    pub foreground: usize,
    pub windows: Vec<VisibleWindow>,
    pub secure: bool,
    pub epoch: u64,
}

pub(super) fn evaluate(
    settings: &Settings,
    snapshot: &PrivacySnapshot,
) -> Option<CaptureSuppressedEventPayload> {
    if snapshot.secure {
        return Some(suppressed(
            "Screen is locked or the input desktop is unavailable.",
        ));
    }
    let needs_process = !settings.excluded_processes.is_empty()
        || !settings.pause_processes.is_empty()
        || !settings.sensitive_window_keywords.is_empty();
    let needs_title = !settings.excluded_window_keywords.is_empty()
        || !settings.pause_window_keywords.is_empty()
        || !settings.sensitive_window_keywords.is_empty();
    let mut outcome: Option<CaptureSuppressedEventPayload> = None;
    for window in &snapshot.windows {
        if (needs_process && !window.process_known) || (needs_title && !window.title_known) {
            if outcome.as_ref().is_none_or(|old| old.mode != "pause") {
                outcome = Some(suppressed(
                    "A visible window could not be checked against privacy rules.",
                ));
            }
        }
        if let Some(policy) = evaluate_capture_policy(settings, &window.title, &window.process) {
            let rank = |mode: &str| match mode {
                "pause" => 3,
                "skip" => 2,
                _ => 1,
            };
            if outcome
                .as_ref()
                .is_none_or(|old| rank(&policy.mode) > rank(&old.mode))
            {
                outcome = Some(policy);
            }
        }
    }
    outcome
}

pub(super) fn suppressed(reason: &str) -> CaptureSuppressedEventPayload {
    CaptureSuppressedEventPayload {
        mode: "skip".into(),
        reason: reason.into(),
        captured: false,
    }
}

pub(super) fn intersects(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < a.2
        && a.1 < a.3
        && b.0 < b.2
        && b.1 < b.3
        && a.0 < b.2
        && a.2 > b.0
        && a.1 < b.3
        && a.3 > b.1
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetLastError, HWND, LPARAM, POINT, RECT,
    };
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    static WINDOW_EPOCH: AtomicU64 = AtomicU64::new(0);
    static TRACKER_READY: AtomicBool = AtomicBool::new(false);

    fn primary() -> Result<(usize, (i32, i32, i32, i32)), String> {
        unsafe {
            let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
                return Err("Cannot resolve primary capture monitor.".into());
            }
            let r = info.rcMonitor;
            Ok((monitor as usize, (r.left, r.top, r.right, r.bottom)))
        }
    }

    struct Enumeration {
        bounds: (i32, i32, i32, i32),
        windows: Vec<VisibleWindow>,
        failed: bool,
    }
    unsafe extern "system" fn enumerate(hwnd: HWND, data: LPARAM) -> i32 {
        let state = &mut *(data as *mut Enumeration);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            4,
        ) >= 0
            && cloaked != 0
        {
            return 1;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            state.failed = true;
            return 1;
        }
        let bounds = (rect.left, rect.top, rect.right, rect.bottom);
        if !intersects(bounds, state.bounds) {
            return 1;
        }
        SetLastError(0);
        let length = GetWindowTextLengthW(hwnd);
        let mut title_known = length >= 0 && GetLastError() == 0;
        let mut title = String::new();
        if length > 0 {
            let mut buffer = vec![0_u16; length as usize + 1];
            let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            title_known = copied > 0;
            if copied > 0 {
                title = String::from_utf16_lossy(&buffer[..copied as usize]);
            }
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut process = String::new();
        if pid != 0 {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !handle.is_null() {
                let mut buffer = [0_u16; 4096];
                let mut length = buffer.len() as u32;
                if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) != 0 {
                    let path = String::from_utf16_lossy(&buffer[..length as usize]);
                    process = std::path::Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                }
                CloseHandle(handle);
            }
        }
        let process_known = !process.is_empty();
        state.windows.push(VisibleWindow {
            handle: hwnd as usize,
            rect: bounds,
            title,
            process,
            title_known,
            process_known,
        });
        1
    }

    pub(in crate::backend) fn snapshot() -> Result<PrivacySnapshot, String> {
        if !TRACKER_READY.load(Ordering::Acquire) {
            return Err("Window privacy tracking is unavailable.".into());
        }
        let epoch = WINDOW_EPOCH.load(Ordering::Acquire);
        let (monitor, bounds) = primary()?;
        let secure = crate::backend::capture::is_secure_desktop_active();
        let foreground = unsafe { GetForegroundWindow() } as usize;
        if secure {
            return Ok(PrivacySnapshot {
                monitor,
                bounds,
                foreground,
                windows: vec![],
                secure,
                epoch,
            });
        }
        let mut state = Enumeration {
            bounds,
            windows: Vec::new(),
            failed: false,
        };
        if unsafe { EnumWindows(Some(enumerate), (&mut state as *mut Enumeration) as LPARAM) } == 0
            || state.failed
        {
            return Err("Unable to enumerate visible windows for privacy checks.".into());
        }
        if WINDOW_EPOCH.load(Ordering::Acquire) != epoch {
            return Err("Visible windows changed during privacy inspection.".into());
        }
        // Keep z-order: a changed overlap/composition also invalidates acquisition.
        Ok(PrivacySnapshot {
            monitor,
            bounds,
            foreground,
            windows: state.windows,
            secure,
            epoch,
        })
    }

    unsafe extern "system" fn changed(
        _: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        object: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        if event < EVENT_OBJECT_CREATE || object == OBJID_WINDOW {
            let relevant = if hwnd.is_null() {
                true
            } else {
                let mut rect: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut rect) == 0
                    || primary()
                        .map(|(_, bounds)| {
                            intersects((rect.left, rect.top, rect.right, rect.bottom), bounds)
                        })
                        .unwrap_or(true)
            };
            if relevant {
                WINDOW_EPOCH.fetch_add(1, Ordering::AcqRel);
            }
        }
    }

    pub(in crate::backend) struct Tracker {
        thread_id: u32,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Tracker {
        pub(in crate::backend) fn start() -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let thread = std::thread::Builder::new()
                .name("memorylane-window-privacy".into())
                .spawn(move || unsafe {
                    let mut message: MSG = std::mem::zeroed();
                    PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                    let system = SetWinEventHook(
                        EVENT_SYSTEM_FOREGROUND,
                        EVENT_SYSTEM_DESKTOPSWITCH,
                        std::ptr::null_mut(),
                        Some(changed),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    );
                    let objects = SetWinEventHook(
                        EVENT_OBJECT_CREATE,
                        EVENT_OBJECT_NAMECHANGE,
                        std::ptr::null_mut(),
                        Some(changed),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    );
                    let ready = !system.is_null() && !objects.is_null();
                    TRACKER_READY.store(ready, Ordering::Release);
                    let _ = tx.send((GetCurrentThreadId(), ready));
                    if ready {
                        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                            DispatchMessageW(&message);
                        }
                    }
                    TRACKER_READY.store(false, Ordering::Release);
                    if !system.is_null() {
                        UnhookWinEvent(system);
                    }
                    if !objects.is_null() {
                        UnhookWinEvent(objects);
                    }
                })
                .map_err(|e| e.to_string())?;
            let (thread_id, ready) = rx.recv().map_err(|e| e.to_string())?;
            if !ready {
                let _ = thread.join();
                return Err("Cannot start window privacy tracking.".into());
            }
            Ok(Self {
                thread_id,
                thread: Some(thread),
            })
        }
    }
    impl Drop for Tracker {
        fn drop(&mut self) {
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(windows)]
pub(super) use native::{snapshot, Tracker};
#[cfg(not(windows))]
pub(super) struct Tracker;
#[cfg(not(windows))]
impl Tracker {
    pub fn start() -> Result<Self, String> {
        Ok(Self)
    }
}
#[cfg(not(windows))]
pub(super) fn snapshot() -> Result<PrivacySnapshot, String> {
    Err("Visible-window privacy inspection requires Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visible_non_foreground_windows_and_unknown_metadata_enforce_rules() {
        let (_temp, state) = crate::backend::tests::build_test_state();
        let mut settings = state.coordinator.lock().settings.clone();
        settings.excluded_processes = vec!["secret.exe".into()];
        let mut snapshot = PrivacySnapshot {
            monitor: 1,
            bounds: (0, 0, 1920, 1080),
            foreground: 1,
            secure: false,
            epoch: 0,
            windows: vec![VisibleWindow {
                handle: 2,
                rect: (10, 10, 100, 100),
                title: "Secret".into(),
                process: "secret.exe".into(),
                title_known: true,
                process_known: true,
            }],
        };
        assert_eq!(evaluate(&settings, &snapshot).unwrap().mode, "skip");
        snapshot.windows[0].process.clear();
        snapshot.windows[0].process_known = false;
        assert!(evaluate(&settings, &snapshot)
            .unwrap()
            .reason
            .contains("could not be checked"));
        settings.excluded_processes.clear();
        settings.sensitive_window_keywords = vec!["secret".into()];
        settings.sensitive_capture_mode = crate::backend::SensitiveCaptureMode::Redact;
        snapshot.windows[0].process_known = true;
        assert_eq!(evaluate(&settings, &snapshot).unwrap().mode, "redact");
        snapshot.secure = true;
        assert_eq!(evaluate(&settings, &snapshot).unwrap().mode, "skip");
    }
    #[test]
    fn monitor_intersection_requires_visible_area() {
        assert!(intersects((-10, 10, 10, 30), (0, 0, 1920, 1080)));
        assert!(!intersects((1920, 0, 2000, 100), (0, 0, 1920, 1080)));
        assert!(!intersects((0, 0, 0, 0), (0, 0, 1920, 1080)));
        assert!(!intersects((20, 20, 20, 20), (0, 0, 1920, 1080)));
    }
}
