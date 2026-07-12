fn main() {
    #[cfg(target_os = "macos")]
    {
        // ── Embed Info.plist into the binary ──
        // In dev mode, the app runs as a bare binary without an .app bundle.
        // macOS reads NSScreenCaptureUsageDescription from the embedded
        // __info_plist section to know whether to show the Screen Recording
        // permission prompt.
        let info_plist_path = std::path::Path::new("Info.plist");
        if info_plist_path.exists() {
            let abs_path = std::fs::canonicalize(info_plist_path)
                .expect("Failed to resolve Info.plist path");
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                abs_path.display()
            );
        }

        // ── Swift runtime rpaths ──
        // Needed so the binary can find libswift_Concurrency.dylib
        // used by the screencapturekit crate's Swift bridge.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        if let Ok(output) = std::process::Command::new("xcode-select").arg("-p").output() {
            if output.status.success() {
                let xcode_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!(
                    "cargo:rustc-link-arg=-Wl,-rpath,{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx"
                );
                println!(
                    "cargo:rustc-link-arg=-Wl,-rpath,{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx"
                );
            }
        }
    }

    tauri_build::build();
}
