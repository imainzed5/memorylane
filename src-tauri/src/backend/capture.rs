//! Primary-display screen capture.
//!
//! On Windows the primary path is Windows.Graphics.Capture, which reads the
//! DWM-composited frame and therefore sees GPU-rendered content (Chromium and
//! Electron apps, video, HDR displays) that GDI BitBlt returns as black. GDI via
//! the `screenshots` crate stays as a fallback for systems without WGC support.

use image::RgbaImage;
use screenshots::Screen;

/// Share of sampled pixels that must be near-black for a frame to count as blank.
const BLANK_DARK_SHARE: f64 = 0.995;
/// Luma at or below which a sampled pixel counts as near-black.
const BLANK_LUMA_THRESHOLD: u32 = 12;
const BLANK_SAMPLE_COLUMNS: u32 = 96;
const BLANK_SAMPLE_ROWS: u32 = 54;

pub(super) enum CaptureOutcome {
    Frame(RgbaImage),
    /// Every backend produced an all-black frame (display off, protected content).
    Blank,
}

/// Captures the primary display, preferring WGC and falling back to GDI when
/// WGC fails or hands back a blank frame.
pub(super) fn capture_primary_display() -> Result<CaptureOutcome, String> {
    #[cfg(target_os = "windows")]
    let wgc_error = match graphics_capture::capture_primary_monitor() {
        Ok(frame) if !is_blank_frame(&frame) => return Ok(CaptureOutcome::Frame(frame)),
        Ok(_) => None,
        Err(error) => Some(error),
    };
    #[cfg(not(target_os = "windows"))]
    let wgc_error: Option<String> = None;

    match capture_with_gdi() {
        Ok(frame) if !is_blank_frame(&frame) => Ok(CaptureOutcome::Frame(frame)),
        Ok(_) => Ok(CaptureOutcome::Blank),
        Err(gdi_error) => Err(match wgc_error {
            Some(wgc_error) => format!("{wgc_error}; GDI fallback also failed: {gdi_error}"),
            None => gdi_error,
        }),
    }
}

fn capture_with_gdi() -> Result<RgbaImage, String> {
    let screen = match Screen::from_point(0, 0) {
        Ok(screen) => screen,
        Err(_) => Screen::all()
            .map_err(|error| format!("failed to list displays: {error}"))?
            .into_iter()
            .next()
            .ok_or_else(|| "no display available for capture".to_string())?,
    };

    screen
        .capture()
        .map_err(|error| format!("failed to capture primary display: {error}"))
}

/// True when nearly every sampled pixel is black. Dark-themed desktops still
/// have bright text, icons and a taskbar, so they stay well under the threshold.
pub(super) fn is_blank_frame(frame: &RgbaImage) -> bool {
    let (width, height) = frame.dimensions();
    if width == 0 || height == 0 {
        return true;
    }

    let columns = BLANK_SAMPLE_COLUMNS.min(width);
    let rows = BLANK_SAMPLE_ROWS.min(height);
    let mut dark = 0_u64;

    for row in 0..rows {
        let y = (row * height + height / 2) / rows;
        for column in 0..columns {
            let x = (column * width + width / 2) / columns;
            let [r, g, b, _] = frame.get_pixel(x.min(width - 1), y.min(height - 1)).0;
            let luma = (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000;
            if luma <= BLANK_LUMA_THRESHOLD {
                dark += 1;
            }
        }
    }

    dark as f64 / (columns as u64 * rows as u64) as f64 >= BLANK_DARK_SHARE
}

/// True when the input desktop is not the user's desktop: the lock screen,
/// a UAC prompt or Ctrl+Alt+Del. Capturing then only yields black frames.
#[cfg(target_os = "windows")]
pub(super) fn is_secure_desktop_active() -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
        DESKTOP_READOBJECTS, UOI_NAME,
    };

    unsafe {
        // The user's session can't open the Winlogon desktop, so failure here
        // means a secure desktop has input.
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else {
            return true;
        };

        let mut name = [0_u16; 64];
        let mut needed = 0_u32;
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * std::mem::size_of::<u16>()) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desktop);

        if read.is_err() {
            return false;
        }

        let length = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
        !String::from_utf16_lossy(&name[..length]).eq_ignore_ascii_case("Default")
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn is_secure_desktop_active() -> bool {
    false
}

#[cfg(target_os = "windows")]
mod graphics_capture {
    use std::time::{Duration, Instant};

    use image::RgbaImage;
    use windows::core::{factory, Interface};
    use windows::Graphics::Capture::{
        Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
        GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::{HMODULE, POINT};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    const FRAME_TIMEOUT: Duration = Duration::from_millis(1500);
    const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(8);

    pub(super) fn capture_primary_monitor() -> Result<RgbaImage, String> {
        // Capture runs on worker threads; an "already initialized" result is fine.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };

        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err("Windows.Graphics.Capture is not supported on this system".to_string());
        }

        let (device, context) = create_d3d_device()?;
        let winrt_device = winrt_device(&device)?;

        let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|error| format!("failed to get capture item factory: {error}"))?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(monitor) }
            .map_err(|error| format!("failed to create capture item for primary monitor: {error}"))?;
        let size = item
            .Size()
            .map_err(|error| format!("failed to read capture item size: {error}"))?;

        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(|error| format!("failed to create capture frame pool: {error}"))?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|error| format!("failed to create capture session: {error}"))?;

        // Both are optional extras on older builds of Windows; ignore failures.
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);

        let result = session
            .StartCapture()
            .map_err(|error| format!("failed to start capture session: {error}"))
            .and_then(|_| wait_for_frame(&pool))
            .and_then(|frame| {
                let image = read_frame(&frame, &device, &context);
                let _ = frame.Close();
                image
            });

        let _ = session.Close();
        let _ = pool.Close();
        result
    }

    fn create_d3d_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
        let attempt = |driver_type: D3D_DRIVER_TYPE| {
            let mut device = None;
            let mut context = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    driver_type,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            }
            .ok()
            .and(device.zip(context))
        };

        attempt(D3D_DRIVER_TYPE_HARDWARE)
            .or_else(|| attempt(D3D_DRIVER_TYPE_WARP))
            .ok_or_else(|| "failed to create a Direct3D 11 device for capture".to_string())
    }

    fn winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice, String> {
        let dxgi_device: IDXGIDevice = device
            .cast()
            .map_err(|error| format!("failed to get DXGI device: {error}"))?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
            .map_err(|error| format!("failed to wrap Direct3D device for WinRT: {error}"))?;
        inspectable
            .cast()
            .map_err(|error| format!("failed to cast WinRT Direct3D device: {error}"))
    }

    fn wait_for_frame(pool: &Direct3D11CaptureFramePool) -> Result<Direct3D11CaptureFrame, String> {
        let deadline = Instant::now() + FRAME_TIMEOUT;
        loop {
            // A free-threaded pool fills asynchronously; an empty pool returns null.
            if let Ok(frame) = pool.TryGetNextFrame() {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err("timed out waiting for a captured frame".to_string());
            }
            std::thread::sleep(FRAME_POLL_INTERVAL);
        }
    }

    fn read_frame(
        frame: &Direct3D11CaptureFrame,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
    ) -> Result<RgbaImage, String> {
        let surface = frame
            .Surface()
            .map_err(|error| format!("failed to read captured surface: {error}"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|error| format!("failed to access captured surface: {error}"))?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }
            .map_err(|error| format!("failed to get captured texture: {error}"))?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        desc.MipLevels = 1;
        desc.ArraySize = 1;

        let mut staging = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
            .map_err(|error| format!("failed to create staging texture: {error}"))?;
        let staging =
            staging.ok_or_else(|| "Direct3D returned no staging texture".to_string())?;

        unsafe { context.CopyResource(&staging, &texture) };

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .map_err(|error| format!("failed to map staging texture: {error}"))?;

        let width = desc.Width as usize;
        let height = desc.Height as usize;
        let pitch = mapped.RowPitch as usize;
        let mut rgba = Vec::with_capacity(width * height * 4);

        unsafe {
            let base = mapped.pData as *const u8;
            for y in 0..height {
                let row = std::slice::from_raw_parts(base.add(y * pitch), width * 4);
                for bgra in row.chunks_exact(4) {
                    rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
                }
            }
            context.Unmap(&staging, 0);
        }

        RgbaImage::from_raw(desc.Width, desc.Height, rgba)
            .ok_or_else(|| "captured frame had an unexpected size".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::is_blank_frame;
    use image::{Rgba, RgbaImage};

    #[test]
    fn solid_black_frame_is_blank() {
        let frame = RgbaImage::from_pixel(1920, 1080, Rgba([0, 0, 0, 255]));
        assert!(is_blank_frame(&frame));
    }

    #[test]
    fn dark_desktop_with_content_is_not_blank() {
        let mut frame = RgbaImage::from_pixel(1920, 1080, Rgba([18, 18, 22, 255]));
        for y in 1032..1080 {
            for x in 0..1920 {
                frame.put_pixel(x, y, Rgba([40, 40, 48, 255]));
            }
        }
        assert!(!is_blank_frame(&frame));
    }

    #[test]
    fn black_window_with_visible_taskbar_is_not_blank() {
        let mut frame = RgbaImage::from_pixel(1920, 1080, Rgba([0, 0, 0, 255]));
        for y in 1032..1080 {
            for x in 0..1920 {
                frame.put_pixel(x, y, Rgba([32, 32, 32, 255]));
            }
        }
        assert!(!is_blank_frame(&frame));
    }

    #[test]
    fn empty_frame_is_blank() {
        assert!(is_blank_frame(&RgbaImage::new(0, 0)));
    }

    /// Captures the real screen; run with `cargo test live_ -- --ignored --nocapture`.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn live_graphics_capture_returns_frame() {
        let started = std::time::Instant::now();
        let frame = super::graphics_capture::capture_primary_monitor().expect("WGC capture failed");
        let wgc_ms = started.elapsed().as_millis();

        let started = std::time::Instant::now();
        let gdi = super::capture_with_gdi().expect("GDI capture failed");
        let gdi_ms = started.elapsed().as_millis();

        println!(
            "WGC {}x{} in {wgc_ms} ms (blank: {}); GDI {}x{} in {gdi_ms} ms (blank: {}); secure desktop: {}",
            frame.width(),
            frame.height(),
            is_blank_frame(&frame),
            gdi.width(),
            gdi.height(),
            is_blank_frame(&gdi),
            super::is_secure_desktop_active(),
        );
        assert!(frame.width() > 0 && frame.height() > 0);
    }
}
