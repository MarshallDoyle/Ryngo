// RYNGO: Native screenshot and screen view capability.
// Allows AI agents (Claude Code, Codex) to programmatically capture
// screenshots without user interaction for documentation, debugging,
// and development workflows.
//
// Usage:
//   ryngo screenshot                    # full screen capture
//   ryngo screenshot --window           # capture active window
//   ryngo screenshot --region 0,0,800,600  # capture specific region
//   ryngo screenshot --output /path.png # save to specific path
//   ryngo screenshot --display 0        # capture specific display

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Parser, Clone)]
pub struct ScreenshotCommand {
    /// Capture only the active/frontmost window instead of the full screen.
    #[arg(long)]
    pub window: bool,

    /// Capture a specific rectangular region: x,y,width,height (in pixels).
    /// Example: --region 100,200,800,600
    #[arg(long, value_parser = parse_region)]
    pub region: Option<Region>,

    /// Save screenshot to a specific file path.
    /// Defaults to ~/.ryngo/screenshots/<timestamp>.png
    #[arg(long, short = 'o', value_hint = clap::ValueHint::FilePath)]
    pub output: Option<PathBuf>,

    /// Capture a specific display by index (0-based).
    /// Without this flag, captures the main display (or all displays).
    #[arg(long)]
    pub display: Option<u32>,

    /// Output format: png (default) or jpg.
    #[arg(long, default_value = "png")]
    pub format: String,

    /// Capture without the cursor visible.
    #[arg(long)]
    pub no_cursor: bool,

    /// After capturing, print only the file path (no extra output).
    /// Useful for programmatic access by AI agents.
    #[arg(long)]
    pub quiet: bool,
}

#[derive(Debug, Clone)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn parse_region(s: &str) -> Result<Region, String> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 4 {
        return Err("Region must be specified as x,y,width,height (e.g. 100,200,800,600)".into());
    }
    Ok(Region {
        x: parts[0].parse().map_err(|e| format!("invalid x: {}", e))?,
        y: parts[1].parse().map_err(|e| format!("invalid y: {}", e))?,
        width: parts[2]
            .parse()
            .map_err(|e| format!("invalid width: {}", e))?,
        height: parts[3]
            .parse()
            .map_err(|e| format!("invalid height: {}", e))?,
    })
}

impl ScreenshotCommand {
    pub fn run(&self) -> Result<()> {
        // Ensure screenshot directory exists
        let screenshot_dir = dirs_next::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".ryngo")
            .join("screenshots");
        std::fs::create_dir_all(&screenshot_dir)
            .context("Failed to create ~/.ryngo/screenshots/ directory")?;

        // Determine output path
        let output_path = match &self.output {
            Some(path) => path.clone(),
            None => {
                let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
                screenshot_dir.join(format!("screenshot-{}.{}", timestamp, self.format))
            }
        };

        // Dispatch to platform-specific capture
        #[cfg(target_os = "macos")]
        self.capture_macos(&output_path)?;

        #[cfg(target_os = "windows")]
        self.capture_windows(&output_path)?;

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        anyhow::bail!("Screenshot capture is not supported on this platform");

        // Output the path
        if self.quiet {
            println!("{}", output_path.display());
        } else {
            println!("Screenshot saved: {}", output_path.display());
        }

        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn capture_macos(&self, output_path: &PathBuf) -> Result<()> {
        // Use macOS built-in `screencapture` tool for reliable capture.
        // This works without user interaction when called programmatically.
        let mut cmd = Command::new("screencapture");

        // Output format
        cmd.arg("-t").arg(&self.format);

        // No sound
        cmd.arg("-x");

        // No cursor if requested
        if self.no_cursor {
            cmd.arg("-C");
        }

        if self.window {
            // Capture the frontmost window (non-interactive)
            cmd.arg("-l");
            // Get the frontmost window ID using AppleScript
            let window_id = get_frontmost_window_id_macos()?;
            cmd.arg(window_id.to_string());
        } else if let Some(region) = &self.region {
            // Capture specific region
            cmd.arg("-R").arg(format!(
                "{},{},{},{}",
                region.x, region.y, region.width, region.height
            ));
        } else if let Some(display) = self.display {
            // Capture specific display
            cmd.arg("-D").arg((display + 1).to_string());
        }
        // else: full screen capture (default)

        cmd.arg(output_path);

        let status = cmd
            .status()
            .context("Failed to run screencapture. Is this macOS?")?;

        if !status.success() {
            anyhow::bail!("screencapture exited with status: {}", status);
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn capture_windows(&self, output_path: &PathBuf) -> Result<()> {
        // On Windows, use PowerShell to capture the screen.
        // This uses the .NET System.Drawing and System.Windows.Forms APIs.
        let script = if self.window {
            // Capture active window
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$hwnd = (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object { [datetime]::Now } | Select-Object -First 1).MainWindowHandle
$rect = New-Object System.Drawing.Rectangle
$sig = '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out System.Drawing.Rectangle lpRect);'
$type = Add-Type -MemberDefinition $sig -Name 'Win32' -Namespace 'Ryngo' -PassThru
$type::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Width - $rect.X
$height = $rect.Height - $rect.Y
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.X, $rect.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
"#.to_string()
        } else if let Some(region) = &self.region {
            format!(
                r#"
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap({2}, {3})
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen({0}, {1}, 0, 0, (New-Object System.Drawing.Size({2}, {3})))
"#,
                region.x, region.y, region.width, region.height
            )
        } else {
            // Full screen capture
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
"#.to_string()
        };

        let save_line = format!(
            "$bitmap.Save('{}')\n$graphics.Dispose()\n$bitmap.Dispose()",
            output_path.display()
        );
        let full_script = format!("{}\n{}", script, save_line);

        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &full_script])
            .status()
            .context("Failed to run PowerShell for screen capture")?;

        if !status.success() {
            anyhow::bail!("PowerShell screenshot capture failed with status: {}", status);
        }

        Ok(())
    }
}

/// Get the window ID of the Ryngo (or frontmost) window on macOS.
/// Uses the CGWindowListCopyWindowInfo API via Swift to enumerate windows.
#[cfg(target_os = "macos")]
fn get_frontmost_window_id_macos() -> Result<u32> {
    // Use swift to call CoreGraphics API directly — no Python dependency needed.
    let swift_code = r#"
import CoreGraphics
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}
// Try to find a ryngo-gui window first
for w in windowList {
    if let owner = w[kCGWindowOwnerName as String] as? String,
       owner.lowercased().contains("ryngo") {
        if let num = w[kCGWindowNumber as String] as? Int {
            print(num)
            exit(0)
        }
    }
}
// Fall back to the frontmost normal window (layer 0 with a name)
for w in windowList {
    let layer = w[kCGWindowLayer as String] as? Int ?? 999
    let name = w[kCGWindowName as String] as? String ?? ""
    if layer == 0 && !name.isEmpty {
        if let num = w[kCGWindowNumber as String] as? Int {
            print(num)
            exit(0)
        }
    }
}
exit(1)
"#;

    let output = Command::new("swift")
        .args(["-e", swift_code])
        .output()
        .context("Failed to enumerate windows via swift/CoreGraphics")?;

    let id_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id_str.is_empty() || !output.status.success() {
        anyhow::bail!(
            "No suitable window found. Try --region or omit --window for full screen capture."
        );
    }
    id_str
        .parse::<u32>()
        .context(format!("Failed to parse window ID '{}'", id_str))
}
